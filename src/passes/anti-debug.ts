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

    // Phase 1b: Cascade-remove obfuscated wrapper functions whose body is purely anti-debug boilerplate.
    // After Phase 1 removes nested anti-debug FunctionDeclarations (e.g., _0x42a16e), the parent
    // wrapper (e.g., _0x565abf) may only contain a try/catch calling the removed helper.
    // Uses strict structural check: only removes if body consists exclusively of try/catch,
    // if/else, calls to removed names, and returns of removed names. No arithmetic, no loops,
    // no property access — those indicate business logic.
    let phase1bChanged = true;
    while (phase1bChanged) {
      phase1bChanged = false;
      traverse(ast, {
        FunctionDeclaration(path) {
          if (!path.node.id || !t.isIdentifier(path.node.id)) return;
          if (!isObfuscatedName(path.node.id.name)) return;
          if (isOnlyAntiDebugBoilerplate(path.node.body, removedNames)) {
            removedNames.add(path.node.id.name);
            path.remove();
            phase1bChanged = true;
          }
        },
      });
    }

    // Phase 2: Remove self-defending guards — var x = factory(this, function() { ...(((.+)+)+)+$... }); x();
    // Also handles multi-declarator var statements
    traverse(ast, {
      VariableDeclarator(path) {
        if (!t.isIdentifier(path.node.id) || !path.node.init) return;
        if (!t.isCallExpression(path.node.init)) return;

        // Check if any argument function contains the self-defending regex, console override,
        // or the init/chain/input self-defending pattern.
        // Uses shallow versions that stop at nested function boundaries to avoid
        // false positives from dead-code-injected patterns in nested functions.
        for (const arg of path.node.init.arguments) {
          if (!t.isFunctionExpression(arg) && !t.isArrowFunctionExpression(arg)) continue;
          if (shallowContainsString(arg, "(((.+)+)+)+$") || shallowIsConsoleOverride(arg) || shallowIsSelfDefendingInitChainInput(arg)) {
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

    // Phase 2b: Remove standalone ExpressionStatements containing anti-debug patterns.
    // Handles the C77-0 two-part pattern where wrapper(this, fn)() has init/chain/input
    // inside fn, and standalone IIFEs whose own body (shallow) contains anti-debug patterns.
    traverse(ast, {
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!t.isCallExpression(expr)) return;

        // Case A: Direct call with anti-debug function arg (not an IIFE)
        // e.g., wrapper(this, function() { ...init/chain/input... })()
        if (isCallWithAntiDebugArg(expr)) {
          path.remove();
          return;
        }

        // Case B: IIFE whose body is purely anti-debug
        const fn = extractIIFEFunction(expr);
        if (!fn) return;
        if (isAntiDebugIIFE(fn)) {
          path.remove();
        }
      },
    });

    // Phase 3: Remove calls/references to removed names — direct calls, setInterval, IIFEs containing them
    // Also handles SequenceExpressions (comma operator) by filtering individual sub-expressions.
    let changed = true;
    let phase3iters = 0;
    while (changed && phase3iters < 10) {
      changed = false;
      phase3iters++;
      traverse(ast, {
        ExpressionStatement(path) {
          const expr = path.node.expression;

          // Handle SequenceExpressions: (iife(), console.log()) — filter removable sub-expressions
          if (t.isSequenceExpression(expr)) {
            const exprs = expr.expressions;
            for (let i = exprs.length - 1; i >= 0; i--) {
              if (isRemovableExpr(exprs[i], removedNames)) {
                exprs.splice(i, 1);
                changed = true;
              }
            }
            if (exprs.length === 0) {
              path.remove();
            } else if (exprs.length === 1) {
              path.node.expression = exprs[0];
            }
            return;
          }

          if (isRemovableExpr(expr, removedNames)) {
            path.remove();
            changed = true;
          }
        },
      });
    }

    // Phase 4: Remove dead obfuscation artifacts — unreferenced _0x-named function/variable declarations
    // Only removes obfuscation-pattern names to avoid accidentally deleting business logic.
    // When the initializer has side effects (method calls like .shift()), preserves the
    // expression as an ExpressionStatement instead of removing it entirely.
    changed = true;
    let phase4iters = 0;
    while (changed && phase4iters < 10) {
      changed = false;
      phase4iters++;
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
          if (!varDecl || !t.isVariableDeclaration(varDecl.node)) return;
          // Never remove the LHS of for-in/for-of — iteration variable is structurally required
          const grandparent = varDecl.parentPath;
          if (grandparent?.isForInStatement() || grandparent?.isForOfStatement()) return;
          // If the initializer has side effects, preserve as ExpressionStatement
          const init = path.node.init;
          if (init && hasSideEffects(init, removedNames)) {
            if (varDecl.node.declarations.length === 1) {
              varDecl.replaceWith(t.expressionStatement(init));
            } else {
              return; // multi-declarator with side effects — leave it
            }
          } else if (varDecl.node.declarations.length === 1) {
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

/**
 * Check if a function body DIRECTLY contains .constructor("debugger") or .constructor("while (true) {}")
 * Skips ALL nested function boundaries (FunctionExpression, ArrowFunctionExpression, FunctionDeclaration)
 * because dead-code injection can inject constructor traps inside nested functions within
 * business-logic code. Only traps at the function's own body level count.
 */
function containsConstructorTrap(path: NodePath<t.FunctionDeclaration>): boolean {
  let found = false;
  path.traverse({
    // Skip all nested function boundaries — traps inside them don't make the outer function anti-debug
    FunctionExpression(p) { p.skip(); },
    ArrowFunctionExpression(p) { p.skip(); },
    FunctionDeclaration(p) { p.skip(); },
    StringLiteral(innerPath) {
      if (found) return;
      const val = innerPath.node.value;
      if (val !== "debugger" && val !== "while (true) {}") return;
      const callee = innerPath.parent;
      if (
        t.isCallExpression(callee) &&
        t.isMemberExpression(callee.callee) &&
        isPropertyNamed(callee.callee, "constructor")
      ) {
        found = true;
      }
    },
    // Also detect split "debu" + "gger" pattern: .constructor("debu" + "gger")
    BinaryExpression(innerPath) {
      if (found) return;
      if (innerPath.node.operator !== "+") return;
      if (!t.isStringLiteral(innerPath.node.left) || !t.isStringLiteral(innerPath.node.right)) return;
      const combined = innerPath.node.left.value + innerPath.node.right.value;
      if (combined !== "debugger") return;
      const callee = innerPath.parent;
      if (
        t.isCallExpression(callee) &&
        t.isMemberExpression(callee.callee) &&
        isPropertyNamed(callee.callee, "constructor")
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

/**
 * Check if a function body is a console-override pattern.
 * Requires BOTH: an array with ["log","warn","info","error",...] AND a console property
 * assignment (console[x] = ...). This prevents false positives on legit code that
 * happens to have an array of method names.
 */
function isConsoleOverride(fn: t.FunctionExpression | t.ArrowFunctionExpression): boolean {
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;

  let hasMethodArray = false;
  let hasConsoleAssign = false;

  function walk(node: t.Node): void {
    if (hasMethodArray && hasConsoleAssign) return;
    if (t.isArrayExpression(node)) {
      const strs = node.elements
        .filter((el): el is t.StringLiteral => t.isStringLiteral(el))
        .map((el) => el.value);
      if (strs.includes("log") && strs.includes("warn") && strs.includes("info") && strs.includes("error")) {
        hasMethodArray = true;
      }
    }
    // Detect console[x] = ... (assignment to console property)
    if (t.isAssignmentExpression(node) &&
        t.isMemberExpression(node.left) &&
        t.isIdentifier(node.left.object) &&
        node.left.object.name === "console") {
      hasConsoleAssign = true;
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
  return hasMethodArray && hasConsoleAssign;
}

/** Check if a function body references any identifier from the given set.
 *  Only matches identifiers in reference position — skips property keys,
 *  non-computed member properties, and object property keys.
 */
function referencesAny(fn: t.FunctionExpression | t.ArrowFunctionExpression, names: Set<string>): boolean {
  let found = false;
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;

  function walk(node: t.Node, parentNode?: t.Node, parentKey?: string): void {
    if (found) return;
    if (t.isIdentifier(node) && names.has(node.name)) {
      // Skip non-computed property accesses (obj.name — 'name' is not a reference)
      if (parentNode && t.isMemberExpression(parentNode) && parentKey === "property" && !parentNode.computed) {
        // This is a property name, not a reference
      } else if (parentNode && t.isObjectProperty(parentNode) && parentKey === "key" && !parentNode.computed) {
        // This is an object key, not a reference
      } else {
        found = true;
        return;
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = (node as any)[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (t.isNode(c)) walk(c, node, key);
        }
      } else if (t.isNode(child)) {
        walk(child, node, key);
      }
    }
  }

  walk(body);
  return found;
}

/** Check if an expression is a removable anti-debug artifact */
function isRemovableExpr(expr: t.Expression, removedNames: Set<string>): boolean {
  // Direct call to removed function: removedName(...)
  if (t.isCallExpression(expr) && t.isIdentifier(expr.callee) && removedNames.has(expr.callee.name)) {
    return true;
  }

  // setInterval(removedName, ...)
  if (
    t.isCallExpression(expr) &&
    t.isIdentifier(expr.callee) &&
    expr.callee.name === "setInterval" &&
    expr.arguments.length >= 1
  ) {
    const firstArg = expr.arguments[0];
    if (t.isIdentifier(firstArg) && removedNames.has(firstArg.name)) {
      return true;
    }
  }

  // IIFE containing call to removed function — only if body is purely anti-debug
  if (t.isCallExpression(expr)) {
    const callee = expr.callee;
    if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
      if (referencesAny(callee, removedNames) && isSmallAntiDebugBody(callee, removedNames)) return true;
    }
    // Nested IIFE: (function() { innerCall(this, function() { ... })() })()
    if (t.isCallExpression(callee)) {
      const inner = callee.callee;
      if (t.isFunctionExpression(inner) || t.isArrowFunctionExpression(inner)) {
        if (referencesAny(inner, removedNames) && isSmallAntiDebugBody(inner, removedNames)) return true;
      }
    }
  }

  return false;
}

/**
 * Check if an IIFE body is purely anti-debug wiring (safe to remove entirely).
 * Returns false if the body contains ANY statement that does not reference a
 * removed anti-debug name — such statements are business logic that must survive.
 */
function isSmallAntiDebugBody(fn: t.FunctionExpression | t.ArrowFunctionExpression, removedNames: Set<string>): boolean {
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return true; // arrow with expression body
  // Only remove the entire IIFE if EVERY statement references a removed anti-debug name.
  // A body with even one "clean" statement contains business logic.
  return body.body.every(stmt => nodeReferencesAny(stmt, removedNames));
}

/** Check if an arbitrary AST node references any identifier from the given set. */
function nodeReferencesAny(node: t.Node, names: Set<string>): boolean {
  let found = false;

  function walk(n: t.Node, parentNode?: t.Node, parentKey?: string): void {
    if (found) return;
    if (t.isIdentifier(n) && names.has(n.name)) {
      if (parentNode && t.isMemberExpression(parentNode) && parentKey === "property" && !parentNode.computed) {
        // property name, not a reference
      } else if (parentNode && t.isObjectProperty(parentNode) && parentKey === "key" && !parentNode.computed) {
        // object key, not a reference
      } else {
        found = true;
        return;
      }
    }
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = (n as any)[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (t.isNode(c)) walk(c, n, key);
        }
      } else if (t.isNode(child)) {
        walk(child, n, key);
      }
    }
  }

  walk(node);
  return found;
}

/**
 * Strict structural check: is the function body purely anti-debug boilerplate?
 * Only returns true if EVERY statement is one of:
 * - ExpressionStatement calling a removed name
 * - ReturnStatement returning a removed name (or nothing)
 * - IfStatement where both branches are recursively boilerplate
 * - TryStatement where both try/catch blocks are recursively boilerplate
 * Any other statement type (loops, assignments, arithmetic, property access) → false.
 * This prevents incorrectly removing functions that have business logic using only params + literals.
 */
function isOnlyAntiDebugBoilerplate(body: t.BlockStatement, removedNames: Set<string>): boolean {
  // Filter out remaining FunctionDeclarations (shouldn't be any after Phase 1, but be safe)
  const stmts = body.body.filter(s => !t.isFunctionDeclaration(s));
  if (stmts.length === 0) return true;
  return stmts.every(stmt => isBoilerplateStmt(stmt, removedNames));
}

function isBoilerplateStmt(node: t.Statement, removedNames: Set<string>): boolean {
  if (t.isExpressionStatement(node)) {
    return isCallToRemovedName(node.expression, removedNames);
  }
  if (t.isReturnStatement(node)) {
    if (!node.argument) return true;
    return t.isIdentifier(node.argument) && removedNames.has(node.argument.name);
  }
  if (t.isIfStatement(node)) {
    const consStmts = t.isBlockStatement(node.consequent)
      ? node.consequent.body : [node.consequent];
    const altStmts = node.alternate
      ? (t.isBlockStatement(node.alternate) ? node.alternate.body : [node.alternate])
      : [];
    return consStmts.every(s => isBoilerplateStmt(s, removedNames)) &&
           altStmts.every(s => isBoilerplateStmt(s, removedNames));
  }
  if (t.isTryStatement(node)) {
    const tryOk = node.block.body.every(s => isBoilerplateStmt(s, removedNames));
    const catchOk = !node.handler || node.handler.body.body.every(s => isBoilerplateStmt(s, removedNames));
    return tryOk && catchOk;
  }
  if (t.isEmptyStatement(node)) return true;
  // Any other statement type (VariableDeclaration, WhileStatement, ForStatement,
  // AssignmentExpression, etc.) indicates business logic
  return false;
}

function isCallToRemovedName(expr: t.Expression, removedNames: Set<string>): boolean {
  return t.isCallExpression(expr) &&
    t.isIdentifier(expr.callee) &&
    removedNames.has(expr.callee.name);
}

function isObfuscatedName(name: string): boolean {
  return /_0x[0-9a-f]+$/i.test(name);
}

/**
 * Check if an expression might have side effects.
 * Returns true for CallExpression, NewExpression, AssignmentExpression, UpdateExpression,
 * UNLESS the call is:
 * - purely to a removed anti-debug name (which no longer exists)
 * - an IIFE (callee is FunctionExpression/ArrowFunctionExpression) — self-contained
 */
function hasSideEffects(node: t.Node, removedNames: Set<string>): boolean {
  if (t.isCallExpression(node)) {
    // Direct call to a removed name — the function was deleted, no side effects
    if (t.isIdentifier(node.callee) && removedNames.has(node.callee.name)) {
      return false;
    }
    // IIFE — self-contained, the result is what gets assigned
    if (t.isFunctionExpression(node.callee) || t.isArrowFunctionExpression(node.callee)) {
      return false;
    }
    return true;
  }
  if (t.isNewExpression(node)) return true;
  if (t.isAssignmentExpression(node) || t.isUpdateExpression(node)) return true;
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    const child = (node as any)[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (t.isNode(c) && hasSideEffects(c, removedNames)) return true;
      }
    } else if (t.isNode(child)) {
      if (hasSideEffects(child, removedNames)) return true;
    }
  }
  return false;
}

/**
 * Check if a function body contains the self-defending "init"/"chain"/"input" pattern.
 * This pattern uses: a call with "init" argument, string concatenation with "chain" and "input",
 * and RegExp tests with "function *\( *\)" pattern.
 */
function isSelfDefendingInitChainInput(fn: t.FunctionExpression | t.ArrowFunctionExpression): boolean {
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;

  let hasInit = false;
  let hasChain = false;
  let hasInput = false;

  function walk(node: t.Node): void {
    if (hasInit && hasChain && hasInput) return;
    if (t.isStringLiteral(node)) {
      if (node.value === "init") hasInit = true;
      if (node.value === "chain") hasChain = true;
      if (node.value === "input") hasInput = true;
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
  return hasInit && hasChain && hasInput;
}

/**
 * Extract the FunctionExpression from an IIFE call expression.
 * Handles: (function(){...})(), (function(){...}()), and nested calls like (function(){...})()()
 */
function extractIIFEFunction(expr: t.CallExpression): t.FunctionExpression | t.ArrowFunctionExpression | null {
  const callee = expr.callee;
  if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
    return callee;
  }
  // Nested call: (function(){...})()() — the outer callee is itself a CallExpression
  if (t.isCallExpression(callee)) {
    const inner = callee.callee;
    if (t.isFunctionExpression(inner) || t.isArrowFunctionExpression(inner)) {
      return inner;
    }
  }
  return null;
}

/**
 * Check if a call expression has a function argument containing anti-debug patterns.
 * Unwraps nested calls: fn(this, callback)() checks callback.
 */
function isCallWithAntiDebugArg(call: t.CallExpression): boolean {
  if (hasAntiDebugFunctionArg(call)) return true;
  // Unwrap nested call: fn(this, callback)()
  if (t.isCallExpression(call.callee)) {
    return hasAntiDebugFunctionArg(call.callee);
  }
  return false;
}

function hasAntiDebugFunctionArg(call: t.CallExpression): boolean {
  for (const arg of call.arguments) {
    if (!t.isFunctionExpression(arg) && !t.isArrowFunctionExpression(arg)) continue;
    // Use shallow versions that stop at nested function boundaries.
    // Dead-code injection can inject anti-debug strings ("init", "chain", "input")
    // into nested functions within business-logic callbacks. Deep walking would
    // false-positive on those injected patterns.
    if (shallowContainsString(arg, "(((.+)+)+)+$") || shallowIsConsoleOverride(arg) || shallowIsSelfDefendingInitChainInput(arg)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an IIFE body is purely anti-debug (safe to remove entirely).
 * Two checks:
 * 1. Every statement is a call with anti-debug function argument (two-part C77-0 pattern)
 * 2. The IIFE body itself (shallow, without recursing into nested functions) is anti-debug
 */
function isAntiDebugIIFE(fn: t.FunctionExpression | t.ArrowFunctionExpression): boolean {
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body || body.body.length === 0) return false;

  // Check 1: every statement is a call with anti-debug function arg
  if (body.body.every(stmt =>
    t.isExpressionStatement(stmt) &&
    t.isCallExpression(stmt.expression) &&
    isCallWithAntiDebugArg(stmt.expression)
  )) {
    return true;
  }

  // Check 2: shallow anti-debug pattern directly in IIFE body
  // Uses shallow walk that does NOT recurse into nested function expressions
  return shallowContainsString(fn, "(((.+)+)+)+$") ||
    shallowIsConsoleOverride(fn) ||
    shallowIsSelfDefendingInitChainInput(fn);
}

/** Like containsString but stops at nested function boundaries */
function shallowContainsString(fn: t.FunctionExpression | t.ArrowFunctionExpression, target: string): boolean {
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;
  let found = false;
  function walk(node: t.Node): void {
    if (found) return;
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return;
    if (t.isFunctionDeclaration(node)) return;
    if (t.isStringLiteral(node) && node.value === target) { found = true; return; }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = (node as any)[key];
      if (Array.isArray(child)) { for (const c of child) { if (t.isNode(c)) walk(c); } }
      else if (t.isNode(child)) { walk(child); }
    }
  }
  walk(body);
  return found;
}

/** Like isConsoleOverride but stops at nested function boundaries */
function shallowIsConsoleOverride(fn: t.FunctionExpression | t.ArrowFunctionExpression): boolean {
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;
  let hasMethodArray = false;
  let hasConsoleAssign = false;
  function walk(node: t.Node): void {
    if (hasMethodArray && hasConsoleAssign) return;
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return;
    if (t.isFunctionDeclaration(node)) return;
    if (t.isArrayExpression(node)) {
      const strs = node.elements.filter((el): el is t.StringLiteral => t.isStringLiteral(el)).map(el => el.value);
      if (strs.includes("log") && strs.includes("warn") && strs.includes("info") && strs.includes("error")) {
        hasMethodArray = true;
      }
    }
    if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left) &&
        t.isIdentifier(node.left.object) && node.left.object.name === "console") {
      hasConsoleAssign = true;
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = (node as any)[key];
      if (Array.isArray(child)) { for (const c of child) { if (t.isNode(c)) walk(c); } }
      else if (t.isNode(child)) { walk(child); }
    }
  }
  walk(body);
  return hasMethodArray && hasConsoleAssign;
}

/** Like isSelfDefendingInitChainInput but stops at nested function boundaries */
function shallowIsSelfDefendingInitChainInput(fn: t.FunctionExpression | t.ArrowFunctionExpression): boolean {
  const body = t.isBlockStatement(fn.body) ? fn.body : null;
  if (!body) return false;
  let hasInit = false, hasChain = false, hasInput = false;
  function walk(node: t.Node): void {
    if (hasInit && hasChain && hasInput) return;
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return;
    if (t.isFunctionDeclaration(node)) return;
    if (t.isStringLiteral(node)) {
      if (node.value === "init") hasInit = true;
      if (node.value === "chain") hasChain = true;
      if (node.value === "input") hasInput = true;
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = (node as any)[key];
      if (Array.isArray(child)) { for (const c of child) { if (t.isNode(c)) walk(c); } }
      else if (t.isNode(child)) { walk(child); }
    }
  }
  walk(body);
  return hasInit && hasChain && hasInput;
}

/** Check if a member expression property matches a name (handles both .prop and ["prop"]) */
function isPropertyNamed(node: t.MemberExpression, name: string): boolean {
  if (!node.computed && t.isIdentifier(node.property) && node.property.name === name) return true;
  if (node.computed && t.isStringLiteral(node.property) && node.property.value === name) return true;
  return false;
}
