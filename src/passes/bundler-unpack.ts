/**
 * Bundler unpacking pass.
 *
 * Detects webpack (v4/v5) and browserify bundle wrappers, extracts
 * individual modules as named function declarations, removing the
 * runtime boilerplate.
 *
 * Webpack 4: (function(modules) { ... __webpack_require__ ... })([ fn, fn, ... ])
 * Webpack 5: (() => { var __webpack_modules__ = {...}; ... })()
 * Browserify: (function(t, n, r) { ... t[o][0].call ... })({id: [fn, deps]}, {}, [entries])
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

export const bundlerUnpackPass: ASTPass = {
  name: "bundler-unpack",
  description: "Detect webpack/browserify bundles and extract individual modules",

  run(ast: File): File {
    const program = ast.program;
    const body = program.body;

    // Bundle is typically a single ExpressionStatement containing an IIFE
    if (body.length !== 1 || !t.isExpressionStatement(body[0])) return ast;

    const expr = body[0].expression;
    if (!t.isCallExpression(expr)) return ast;

    // Try each bundler pattern
    const modules = detectWebpack4(expr) ?? detectWebpack5(expr) ?? detectBrowserify(expr);
    if (!modules || modules.length === 0) return ast;

    // Replace program body with extracted module functions
    const newBody: t.Statement[] = [];
    for (const mod of modules) {
      newBody.push(mod);
    }
    program.body = newBody;

    return ast;
  },
};

interface ExtractedModule {
  id: string;
  fn: t.FunctionExpression | t.ArrowFunctionExpression;
}

/**
 * Detect webpack 4 pattern:
 *   (function(modules) { ... __webpack_require__ ... })([ fn, fn ] or { 0: fn, 1: fn })
 */
function detectWebpack4(expr: t.CallExpression): t.Statement[] | null {
  const callee = unwrapCallee(expr);
  if (!callee) return null;

  // Must be function expression with exactly 1 parameter (modules)
  if (!t.isFunctionExpression(callee)) return null;
  if (callee.params.length !== 1) return null;

  // Body must contain __webpack_require__ function
  if (!containsWebpackRequire(callee.body)) return null;

  // Argument must be array or object of functions
  if (expr.arguments.length !== 1) return null;
  const arg = expr.arguments[0];

  return extractModulesFrom(arg);
}

/**
 * Detect webpack 5 pattern:
 *   (() => { var __webpack_modules__ = {...}; ... })()
 */
function detectWebpack5(expr: t.CallExpression): t.Statement[] | null {
  const callee = unwrapCallee(expr);
  if (!callee) return null;

  // Must be arrow function or function expression with 0 parameters
  if (!t.isArrowFunctionExpression(callee) && !t.isFunctionExpression(callee)) return null;
  if (callee.params.length !== 0) return null;
  if (expr.arguments.length !== 0) return null;

  // Body must contain __webpack_modules__ variable
  const body = t.isBlockStatement(callee.body) ? callee.body : null;
  if (!body) return null;

  // Find __webpack_modules__ declaration
  for (const stmt of body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id)) continue;
      if (decl.id.name === "__webpack_modules__" && decl.init) {
        return extractModulesFrom(decl.init);
      }
    }
  }

  return null;
}

/**
 * Detect browserify pattern:
 *   (function(t, n, r) { ... t[o][0].call ... })({id: [fn, deps]}, {}, [entries])
 */
function detectBrowserify(expr: t.CallExpression): t.Statement[] | null {
  const callee = unwrapCallee(expr);
  if (!callee) return null;

  // Must be function expression with 3 parameters
  if (!t.isFunctionExpression(callee)) return null;
  if (callee.params.length !== 3) return null;

  // Must have 3 arguments: module map, cache (empty object), entry array
  if (expr.arguments.length !== 3) return null;

  const [moduleMapArg, cacheArg, entryArg] = expr.arguments;

  // Third argument should be an array (entry points)
  if (!t.isArrayExpression(entryArg)) return null;
  // Second argument should be an object (empty cache)
  if (!t.isObjectExpression(cacheArg)) return null;
  // First argument should be an object (module map)
  if (!t.isObjectExpression(moduleMapArg)) return null;

  // Validate module map structure: { id: [function, deps], ... }
  const modules: t.Statement[] = [];

  for (const prop of moduleMapArg.properties) {
    if (t.isSpreadElement(prop)) return null;
    if (!t.isObjectProperty(prop)) return null;

    let moduleId: string;
    if (t.isNumericLiteral(prop.key)) {
      moduleId = String(prop.key.value);
    } else if (t.isStringLiteral(prop.key)) {
      moduleId = prop.key.value;
    } else if (t.isIdentifier(prop.key)) {
      moduleId = prop.key.name;
    } else {
      return null;
    }

    // Value must be [function, deps] array
    if (!t.isArrayExpression(prop.value)) return null;
    if (prop.value.elements.length < 1) return null;

    const fnElement = prop.value.elements[0];
    if (!fnElement || (!t.isFunctionExpression(fnElement) && !t.isArrowFunctionExpression(fnElement))) {
      return null;
    }

    modules.push(createModuleFunction(moduleId, fnElement));
  }

  return modules.length > 0 ? modules : null;
}

/**
 * Extract module functions from an array or object expression.
 */
function extractModulesFrom(node: t.Node): t.Statement[] | null {
  const modules: t.Statement[] = [];

  if (t.isArrayExpression(node)) {
    for (let i = 0; i < node.elements.length; i++) {
      const el = node.elements[i];
      if (!el || (!t.isFunctionExpression(el) && !t.isArrowFunctionExpression(el))) return null;
      modules.push(createModuleFunction(String(i), el));
    }
  } else if (t.isObjectExpression(node)) {
    for (const prop of node.properties) {
      if (t.isSpreadElement(prop)) return null;
      if (!t.isObjectProperty(prop)) return null;

      let moduleId: string;
      if (t.isNumericLiteral(prop.key)) {
        moduleId = String(prop.key.value);
      } else if (t.isStringLiteral(prop.key)) {
        moduleId = sanitizeModuleId(prop.key.value);
      } else if (t.isIdentifier(prop.key)) {
        moduleId = prop.key.name;
      } else {
        return null;
      }

      const value = prop.value;
      if (!t.isFunctionExpression(value) && !t.isArrowFunctionExpression(value)) return null;
      modules.push(createModuleFunction(moduleId, value));
    }
  } else {
    return null;
  }

  return modules.length > 0 ? modules : null;
}

/**
 * Create a named function declaration for an extracted module.
 */
function createModuleFunction(
  id: string,
  fn: t.FunctionExpression | t.ArrowFunctionExpression,
): t.FunctionDeclaration {
  const funcName = `__module_${id}__`;
  const params = fn.params.map(p => t.cloneNode(p));

  let body: t.BlockStatement;
  if (t.isBlockStatement(fn.body)) {
    body = t.cloneNode(fn.body);
  } else {
    // Arrow function with expression body
    body = t.blockStatement([t.returnStatement(t.cloneNode(fn.body))]);
  }

  return t.functionDeclaration(t.identifier(funcName), params, body);
}

/**
 * Unwrap the callee from possible ParenthesizedExpression.
 */
function unwrapCallee(expr: t.CallExpression): t.Expression | null {
  let callee = expr.callee;
  if (t.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  if (t.isExpression(callee)) return callee;
  return null;
}

/**
 * Check if a function body contains a __webpack_require__ function declaration or assignment.
 */
function containsWebpackRequire(body: t.BlockStatement): boolean {
  for (const stmt of body.body) {
    // function __webpack_require__(moduleId) { ... }
    if (t.isFunctionDeclaration(stmt) && t.isIdentifier(stmt.id) &&
        stmt.id.name === "__webpack_require__") {
      return true;
    }
  }
  return false;
}

/**
 * Sanitize a module path string for use as a function name.
 * "./src/utils.js" → "src_utils"
 */
function sanitizeModuleId(path: string): string {
  return path
    .replace(/^\.\//, "")
    .replace(/\.[jt]sx?$/, "")
    .replace(/[^a-zA-Z0-9_]/g, "_");
}
