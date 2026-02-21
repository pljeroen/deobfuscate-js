/**
 * Dead code elimination pass — removes unreachable code.
 *
 * Handles:
 * - if(false) blocks removed, if(true) blocks unwrapped
 * - Ternary with constant test simplified
 * - Unused variable declarations removed (when initializer has no side effects)
 * - Unreachable statements after return/throw removed
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

export const deadCodeEliminatePass: ASTPass = {
  name: "dead-code-eliminate",
  description: "Remove unreachable code and unused bindings",

  run(ast: File): File {
    // Pass 1: Remove unreachable branches
    traverse(ast, {
      IfStatement(path) {
        const testResult = path.get("test").evaluate();
        if (!testResult.confident) return;

        if (testResult.value) {
          // if(true) { A } else { B } -> A
          if (t.isBlockStatement(path.node.consequent)) {
            // If the block contains let/const, keep the block to preserve scoping
            if (hasBlockScopedDecl(path.node.consequent)) {
              path.replaceWith(path.node.consequent);
            } else {
              path.replaceWithMultiple(path.node.consequent.body);
            }
          } else {
            path.replaceWith(path.node.consequent);
          }
        } else {
          // if(false) { A } else { B } -> B (or remove entirely)
          if (path.node.alternate) {
            if (t.isBlockStatement(path.node.alternate)) {
              if (hasBlockScopedDecl(path.node.alternate)) {
                path.replaceWith(path.node.alternate);
              } else {
                path.replaceWithMultiple(path.node.alternate.body);
              }
            } else {
              path.replaceWith(path.node.alternate);
            }
          } else {
            path.remove();
          }
        }
      },

      // Ternary with constant test
      ConditionalExpression(path) {
        const testResult = path.get("test").evaluate();
        if (!testResult.confident) return;

        if (testResult.value) {
          path.replaceWith(path.node.consequent);
        } else {
          path.replaceWith(path.node.alternate);
        }
      },
    });

    // Pass 2: Remove unreachable statements after return/throw
    traverse(ast, {
      "BlockStatement|Program"(path) {
        const body = path.isBlockStatement()
          ? path.node.body
          : (path.node as t.Program).body;

        let foundTerminator = false;
        const toRemove: number[] = [];

        for (let i = 0; i < body.length; i++) {
          if (foundTerminator) {
            toRemove.push(i);
            continue;
          }
          const stmt = body[i];
          if (
            t.isReturnStatement(stmt) ||
            t.isThrowStatement(stmt) ||
            t.isBreakStatement(stmt) ||
            t.isContinueStatement(stmt)
          ) {
            foundTerminator = true;
          }
        }

        // Remove in reverse order to preserve indices
        for (let i = toRemove.length - 1; i >= 0; i--) {
          const childPath = (path.get("body") as Array<{ remove(): void }>)[toRemove[i]];
          if (childPath && typeof childPath.remove === "function") {
            childPath.remove();
          }
        }
      },
    });

    // Pass 3: Remove unused variable declarations
    traverse(ast, {
      VariableDeclaration(path) {
        // Never remove the LHS of for-in/for-of — iteration variable is structurally required
        if (path.parentPath?.isForInStatement() || path.parentPath?.isForOfStatement()) return;

        const declarators = path.get("declarations");
        const toRemove: number[] = [];
        const isNested = !!path.getFunctionParent();

        for (let i = 0; i < declarators.length; i++) {
          const decl = declarators[i];
          const id = decl.get("id");
          if (!id.isIdentifier()) continue;

          const binding = decl.scope.getBinding(id.node.name);
          if (!binding) continue;

          // Only remove if no references
          if (binding.referencePaths.length > 0) continue;
          if (binding.constantViolations.length > 0) continue;

          // Check if initializer has side effects
          const init = decl.get("init");
          if (init.node && !isPure(init.node, isNested)) continue;

          toRemove.push(i);
        }

        // Remove unused declarators
        if (toRemove.length === declarators.length) {
          path.remove();
        } else {
          for (let i = toRemove.length - 1; i >= 0; i--) {
            declarators[toRemove[i]].remove();
          }
        }
      },
    });

    // Refresh scope info after Pass 3 mutations before Pass 4
    traverse(ast, { Program(path) { path.scope.crawl(); } });

    // Pass 4: Remove unreferenced nested function declarations (scoped wrappers etc.)
    // Only removes functions inside other functions — top-level may be exports.
    traverse(ast, {
      FunctionDeclaration(path) {
        if (!path.node.id || !t.isIdentifier(path.node.id)) return;
        // Only remove if nested inside another function
        if (!path.parentPath?.getFunctionParent()) return;
        const binding = path.scope.getBinding(path.node.id.name);
        if (!binding) return;
        if (binding.referencePaths.length > 0) return;
        if (binding.constantViolations.length > 0) return;
        path.remove();
      },
    });

    return ast;
  },
};

/** Check if a block statement contains let/const declarations (block-scoped) */
function hasBlockScopedDecl(block: t.BlockStatement): boolean {
  return block.body.some(
    stmt => t.isVariableDeclaration(stmt) && (stmt.kind === "let" || stmt.kind === "const"),
  );
}

function isPure(node: t.Node, allowIIFE = false): boolean {
  if (t.isLiteral(node)) return true;
  // Only known-safe identifiers are pure — unknown identifiers can throw ReferenceError
  if (t.isIdentifier(node)) {
    return node.name === "undefined" || node.name === "NaN" || node.name === "Infinity";
  }
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true;
  if (t.isUnaryExpression(node) && isPure(node.argument, allowIIFE)) return true;
  if (t.isBinaryExpression(node) && isPure(node.left, allowIIFE) && isPure(node.right, allowIIFE)) return true;
  if (t.isArrayExpression(node)) {
    return node.elements.every((el) => el === null || (t.isNode(el) && isPure(el, allowIIFE)));
  }
  if (t.isObjectExpression(node)) {
    return node.properties.every(
      (p) => t.isObjectProperty(p) && isPure(p.value as t.Node, allowIIFE)
    );
  }
  // IIFE with no arguments inside functions: (function(){...})() — closures are
  // self-contained. Only allowed inside functions (not top-level) to avoid removing
  // module-wrapping IIFEs that may have global side effects.
  // Handles obfuscator.io "call controller" (apply-once wrapper) pattern.
  if (allowIIFE && t.isCallExpression(node) &&
      (t.isFunctionExpression(node.callee) || t.isArrowFunctionExpression(node.callee)) &&
      node.arguments.length === 0) return true;
  return false;
}
