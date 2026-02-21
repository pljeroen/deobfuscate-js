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

    // Bundle is typically a single ExpressionStatement containing an IIFE,
    // possibly preceded by "use strict" or a banner comment.
    let iifeExpr: t.CallExpression | null = null;

    if (body.length === 1 && t.isExpressionStatement(body[0]) && t.isCallExpression(body[0].expression)) {
      iifeExpr = body[0].expression;
    } else if (body.length === 2 && t.isExpressionStatement(body[0]) && t.isExpressionStatement(body[1])) {
      // Handle "use strict"; (function...)(modules) pattern
      const first = body[0].expression;
      if (t.isStringLiteral(first) && first.value === "use strict" && t.isCallExpression(body[1].expression)) {
        iifeExpr = body[1].expression;
      }
    }

    if (!iifeExpr) return ast;

    // Try each bundler pattern
    const detection = detectWebpack4(iifeExpr) ?? detectWebpack5(iifeExpr) ?? detectBrowserify(iifeExpr);
    if (!detection || detection.modules.length === 0) return ast;

    // Apply graph-based module naming when there are multiple modules
    if (detection.modules.length > 1) {
      renameModulesByGraph(detection.modules, detection.entryIndex);
    }

    // Build metadata comment
    const comment = ` ${detection.type} bundle | ${detection.modules.length} modules`;

    // Replace program body with metadata comment + extracted module functions
    const commentNode = t.expressionStatement(t.stringLiteral(""));
    t.addComment(commentNode, "leading", comment, false);

    const newBody: t.Statement[] = [commentNode];
    for (const mod of detection.modules) {
      newBody.push(mod);
    }
    program.body = newBody;

    return ast;
  },
};

interface DetectionResult {
  type: string;
  modules: t.Statement[];
  entryIndex?: number;
}

/**
 * Detect webpack 4 pattern:
 *   (function(modules) { ... __webpack_require__ ... })([ fn, fn ] or { 0: fn, 1: fn })
 */
function detectWebpack4(expr: t.CallExpression): DetectionResult | null {
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

  const modules = extractModulesFrom(arg);
  if (!modules) return null;

  const entryIndex = findBootstrapEntry(callee.body);
  return { type: "webpack", modules, entryIndex };
}

/**
 * Detect webpack 5 pattern:
 *   (() => { var __webpack_modules__ = {...}; ... })()
 */
function detectWebpack5(expr: t.CallExpression): DetectionResult | null {
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
        const modules = extractModulesFrom(decl.init);
        return modules ? { type: "webpack5", modules } : null;
      }
    }
  }

  return null;
}

/**
 * Detect browserify pattern:
 *   (function(t, n, r) { ... t[o][0].call ... })({id: [fn, deps]}, {}, [entries])
 */
function detectBrowserify(expr: t.CallExpression): DetectionResult | null {
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

  return modules.length > 0 ? { type: "browserify", modules } : null;
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

/**
 * Find the entry module index from the bootstrap body.
 * Looks for __webpack_require__(N) calls in the top-level bootstrap function.
 */
function findBootstrapEntry(body: t.BlockStatement): number | undefined {
  for (const stmt of body.body) {
    let call: t.CallExpression | null = null;

    if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
      call = stmt.expression;
    } else if (t.isReturnStatement(stmt) && t.isCallExpression(stmt.argument)) {
      call = stmt.argument;
    }

    if (
      call &&
      t.isIdentifier(call.callee) && call.callee.name === "__webpack_require__" &&
      call.arguments.length >= 1 && t.isNumericLiteral(call.arguments[0])
    ) {
      return call.arguments[0].value;
    }
  }
  return undefined;
}

/**
 * Collect __webpack_require__(N) calls from an AST subtree.
 * Returns deduplicated list of required module IDs.
 */
function collectWebpackRequires(node: t.Node): string[] {
  const requires = new Set<string>();
  visitNode(node, (n) => {
    if (
      t.isCallExpression(n) &&
      t.isIdentifier(n.callee) && n.callee.name === "__webpack_require__" &&
      n.arguments.length >= 1 && t.isNumericLiteral(n.arguments[0])
    ) {
      requires.add(String(n.arguments[0].value));
    }
  });
  return [...requires];
}

/**
 * Simple recursive AST visitor.
 */
function visitNode(node: t.Node, cb: (n: t.Node) => void): void {
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" ||
        key === "extra" || key === "leadingComments" || key === "trailingComments" ||
        key === "innerComments") continue;
    const child = (node as any)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && typeof item.type === "string") {
          visitNode(item, cb);
        }
      }
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      visitNode(child, cb);
    }
  }
}

/**
 * Rename extracted module functions based on dependency graph analysis.
 *
 * Naming strategy:
 * - Entry module (called by bootstrap) → __module_entry__
 * - Leaf modules (zero out-degree) → __module_leaf_N__
 * - Utility modules (in-degree >= 2 AND out-degree >= 2) → __module_util_N__
 * - Remaining → __module_N__ (unchanged)
 */
function renameModulesByGraph(modules: t.Statement[], entryIndex?: number): void {
  // Build module map: numeric id → FunctionDeclaration
  const moduleMap = new Map<string, t.FunctionDeclaration>();
  for (const stmt of modules) {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id) continue;
    const match = stmt.id.name.match(/^__module_(\d+)__$/);
    if (!match) continue;
    moduleMap.set(match[1], stmt);
  }

  // Build dependency graph
  const outEdges = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of moduleMap.keys()) {
    outEdges.set(id, []);
    inDegree.set(id, 0);
  }

  for (const [id, func] of moduleMap) {
    const requires = collectWebpackRequires(func.body);
    outEdges.set(id, requires);
    for (const req of requires) {
      if (inDegree.has(req)) {
        inDegree.set(req, inDegree.get(req)! + 1);
      }
    }
  }

  // Only apply graph-based naming when inter-module dependencies exist
  let totalEdges = 0;
  for (const edges of outEdges.values()) {
    totalEdges += edges.length;
  }
  if (totalEdges === 0) return;

  const entryId = entryIndex !== undefined ? String(entryIndex) : undefined;

  // Classify and rename
  for (const [id, func] of moduleMap) {
    const outDeg = outEdges.get(id)?.length ?? 0;
    const inDeg = inDegree.get(id) ?? 0;

    let newName: string;
    if (id === entryId) {
      newName = "__module_entry__";
    } else if (outDeg === 0) {
      newName = `__module_leaf_${id}__`;
    } else if (inDeg >= 2 && outDeg >= 2) {
      newName = `__module_util_${id}__`;
    } else {
      continue; // Keep numeric name
    }

    func.id = t.identifier(newName);
  }
}
