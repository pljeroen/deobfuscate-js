/**
 * Anti-debug and self-defending code removal pass.
 *
 * Detects and removes obfuscator.io anti-debug patterns:
 * - Functions containing .constructor("debugger") or .constructor("while (true) {}")
 * - Console-override IIFEs that replace console.log/warn/etc with no-ops
 * - Self-defending guards that check Function.prototype.toString() with (((.+)+)+)+$ regex
 * - setInterval calls that invoke anti-debug functions
 * - Anti-tamper IIFEs calling removed functions
 *
 * After removal, cleans up dead function declarations and unreferenced variables.
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";
import type { NodePath } from "@babel/traverse";

export const antiDebugPass: ASTPass = {
  name: "anti-debug",
  description: "Remove anti-debug, console-override, and self-defending patterns",

  run(ast: File): File {
    const removedNames = new Set<string>();

    // Phase 1: Remove function declarations with .constructor("debugger") / .constructor("while (true) {}")
    traverse(ast, {
      FunctionDeclaration(path) {
        if (!path.node.id || !t.isIdentifier(path.node.id)) return;
        if (containsConstructorTrap(path)) {
          removedNames.add(path.node.id.name);
          path.remove();
        }
      },
    });

    // Phase 2: Remove self-defending guards — var x = factory(this, function() { ...(((.+)+)+)+$... }); x();
    // Also handles multi-declarator var statements
    traverse(ast, {
      VariableDeclarator(path) {
        if (!t.isIdentifier(path.node.id) || !path.node.init) return;
        if (!t.isCallExpression(path.node.init)) return;

        // Check if any argument function contains the self-defending regex or console override
        for (const arg of path.node.init.arguments) {
          if (!t.isFunctionExpression(arg) && !t.isArrowFunctionExpression(arg)) continue;
          if (containsString(arg, "(((.+)+)+)+$") || isConsoleOverride(arg)) {
            const name = path.node.id.name;
            removedNames.add(name);
            // Remove the subsequent call: name()
            const varDecl = path.parentPath;
            if (varDecl && t.isVariableDeclaration(varDecl.node)) {
              for (const sib of varDecl.getAllNextSiblings()) {
                if (!t.isExpressionStatement(sib.node)) continue;
                if (
                  t.isCallExpression(sib.node.expression) &&
                  t.isIdentifier(sib.node.expression.callee) &&
                  sib.node.expression.callee.name === name
                ) {
                  sib.remove();
                  break;
                }
              }
            }
            path.remove();
            return;
          }
        }
      },
    });

    // Phase 3: Remove calls/references to removed names — direct calls, setInterval, IIFEs containing them
    let changed = true;
    while (changed) {
      changed = false;
      traverse(ast, {
        ExpressionStatement(path) {
          const expr = path.node.expression;

          // Direct call to removed function: removedName(...)
          if (t.isCallExpression(expr) && t.isIdentifier(expr.callee) && removedNames.has(expr.callee.name)) {
            path.remove();
            changed = true;
            return;
          }

          // setInterval(removedName, ...) or setInterval(function() { removedName() }, ...)
          if (
            t.isCallExpression(expr) &&
            t.isIdentifier(expr.callee) &&
            expr.callee.name === "setInterval" &&
            expr.arguments.length >= 1
          ) {
            const firstArg = expr.arguments[0];
            if (t.isIdentifier(firstArg) && removedNames.has(firstArg.name)) {
              path.remove();
              changed = true;
              return;
            }
          }

          // IIFE containing call to removed function
          if (t.isCallExpression(expr)) {
            const callee = expr.callee;
            if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
              if (referencesAny(callee, removedNames)) {
                path.remove();
                changed = true;
                return;
              }
            }
            // Nested IIFE: (function() { innerCall(this, function() { ... })() })()
            if (t.isCallExpression(callee)) {
              const inner = callee.callee;
              if (t.isFunctionExpression(inner) || t.isArrowFunctionExpression(inner)) {
                if (referencesAny(inner, removedNames)) {
                  path.remove();
                  changed = true;
                  return;
                }
              }
            }
          }
        },
      });
    }

    // Phase 4: Remove dead obfuscation artifacts — unreferenced _0x-named function/variable declarations
    // Only removes obfuscation-pattern names to avoid accidentally deleting business logic.
    changed = true;
    while (changed) {
      changed = false;
      traverse(ast, {
        FunctionDeclaration(path) {
          if (!path.node.id || !t.isIdentifier(path.node.id)) return;
          if (!isObfuscatedName(path.node.id.name)) return;
          path.scope.crawl();
          const binding = path.scope.getBinding(path.node.id.name);
          if (!binding) return;
          if (binding.referencePaths.length > 0) return;
          if (binding.constantViolations.length > 0) return;
          path.remove();
          changed = true;
        },
        VariableDeclarator(path) {
          if (!t.isIdentifier(path.node.id)) return;
          if (!isObfuscatedName(path.node.id.name)) return;
          path.scope.crawl();
          const binding = path.scope.getBinding(path.node.id.name);
          if (!binding) return;
          if (binding.referencePaths.length > 0) return;
          if (binding.constantViolations.length > 0) return;
          const varDecl = path.parentPath;
          if (varDecl && t.isVariableDeclaration(varDecl.node) && varDecl.node.declarations.length === 1) {
            varDecl.remove();
          } else {
            path.remove();
          }
          changed = true;
        },
      });
    }

    return ast;
  },
};

/** Check if a function body contains .constructor("debugger") or .constructor("while (true) {}") */
function containsConstructorTrap(path: NodePath<t.FunctionDeclaration>): boolean {
  let found = false;
  path.traverse({
    StringLiteral(innerPath) {
      if (found) return;
      const val = innerPath.node.value;
      if (val !== "debugger" && val !== "while (true) {}") return;
      if (
        t.isCallExpression(innerPath.parent) &&
        t.isMemberExpression(innerPath.parent.callee) &&
        t.isIdentifier(innerPath.parent.callee.property) &&
        innerPath.parent.callee.property.name === "constructor"
      ) {
        found = true;
      }
    },
  });
  return found;
}

/** Check if a function/arrow body contains a specific string literal */
function containsString(fn: t.FunctionExpression | t.ArrowFunctionExpression, target: string): boolean {
  let found = false;
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;

  function walk(node: t.Node): void {
    if (found) return;
    if (t.isStringLiteral(node) && node.value === target) {
      found = true;
      return;
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = (node as any)[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (t.isNode(c)) walk(c);
        }
      } else if (t.isNode(child)) {
        walk(child);
      }
    }
  }

  walk(body);
  return found;
}

/** Check if a function body is a console-override (contains ["log","warn","info","error",...]) */
function isConsoleOverride(fn: t.FunctionExpression | t.ArrowFunctionExpression): boolean {
  let found = false;
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;

  function walk(node: t.Node): void {
    if (found) return;
    if (t.isArrayExpression(node)) {
      const strs = node.elements
        .filter((el): el is t.StringLiteral => t.isStringLiteral(el))
        .map((el) => el.value);
      if (strs.includes("log") && strs.includes("warn") && strs.includes("info") && strs.includes("error")) {
        found = true;
        return;
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = (node as any)[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (t.isNode(c)) walk(c);
        }
      } else if (t.isNode(child)) {
        walk(child);
      }
    }
  }

  walk(body);
  return found;
}

/** Check if a function body references any identifier from the given set */
function referencesAny(fn: t.FunctionExpression | t.ArrowFunctionExpression, names: Set<string>): boolean {
  let found = false;
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;

  function walk(node: t.Node): void {
    if (found) return;
    if (t.isIdentifier(node) && names.has(node.name)) {
      found = true;
      return;
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = (node as any)[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (t.isNode(c)) walk(c);
        }
      } else if (t.isNode(child)) {
        walk(child);
      }
    }
  }

  walk(body);
  return found;
}

function isObfuscatedName(name: string): boolean {
  return /^_0x[0-9a-f]+$/i.test(name);
}

function removeVarAndCalls(path: NodePath<t.VariableDeclaration>, name: string): void {
  const siblings = path.getAllNextSiblings();
  for (const sib of siblings) {
    if (!t.isExpressionStatement(sib.node)) continue;
    if (
      t.isCallExpression(sib.node.expression) &&
      t.isIdentifier(sib.node.expression.callee) &&
      sib.node.expression.callee.name === name
    ) {
      sib.remove();
      break;
    }
  }
  path.remove();
}
