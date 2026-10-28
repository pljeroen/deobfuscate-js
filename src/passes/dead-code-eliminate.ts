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
import type { RuntimeNameFacts } from "./annex-b-linkage.js";
import { runtimeNameFacts } from "./annex-b-linkage.js";

export const deadCodeEliminatePass: ASTPass = {
  name: "dead-code-eliminate",
  description: "Remove unreachable code and unused bindings",

  run(ast: File): File {
    let facts = runtimeNameFacts(ast);
    // Pass 1: Remove unreachable branches
    traverse(ast, {
      IfStatement(path) {
        if (!facts.evaluationSafe(path.get("test"))) return;
        const testResult = path.get("test").evaluate();
        if (!testResult.confident) return;

        const discarded = path.get(testResult.value ? "alternate" : "consequent");
        if (discarded.node && requiresDeclarationInstantiationRetention(discarded, facts)) return;

        if (testResult.value) {
          // if(true) { A } else { B } -> A
          if (t.isBlockStatement(path.node.consequent)) {
            // Keep scope-sensitive declarations inside their original block
            if (hasScopeSensitiveDeclaration(path.node.consequent)) {
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
              if (hasScopeSensitiveDeclaration(path.node.alternate)) {
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
        if (!facts.evaluationSafe(path.get("test"))) return;
        const testResult = path.get("test").evaluate();
        if (!testResult.confident) return;

        const selected = testResult.value ? path.node.consequent : path.node.alternate;
        if (facts.wouldCreateDirectEval(selected, path)) return;
        path.replaceWith(selected);
      },
    });

    // Rebind before the next destructive phase; removed branches change scopes.
    traverse(ast, { Program(path: any) { path.scope.crawl(); } });
    facts = runtimeNameFacts(ast);
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
            // FunctionDeclarations are hoisted — they're available before the return
            if (!t.isFunctionDeclaration(body[i]) && !requiresDeclarationInstantiationRetention(path.get("body")[i], facts)) {
              toRemove.push(i);
            }
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

    traverse(ast, { Program(path: any) { path.scope.crawl(); } });
    facts = runtimeNameFacts(ast);
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

          const declarationScope = path.node.kind === "var"
            ? decl.scope.getFunctionParent() ?? decl.scope.getProgramParent()
            : decl.scope;
          const binding = declarationScope.getBinding(id.node.name);
          if (!binding || facts.observed(binding)) continue;

          // Only remove if no references
          if (binding.referencePaths.length > 0) continue;
          if (binding.constantViolations.length > 0) continue;

          // Check if initializer has side effects
          const init = decl.get("init");
          // A var initializer can write a distinct lexical cell, such as a catch parameter.
          if (path.node.kind === "var" && init.node) {
            const initializerTarget = decl.scope.getBinding(id.node.name);
            if (!initializerTarget || facts.observed(initializerTarget)) continue;
            if (initializerTarget.referencePaths.length > 0) continue;
            if (initializerTarget.constantViolations.length > 0) continue;
          }
          if (init.node && (!facts.intrinsicReadsSafe(init) || !isPure(init.node, isNested))) continue;

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

    facts = runtimeNameFacts(ast);
    // Pass 4: Remove unreferenced nested function declarations (scoped wrappers etc.)
    // Only removes functions inside other functions — top-level may be exports.
    traverse(ast, {
      FunctionDeclaration(path) {
        if (!path.node.id || !t.isIdentifier(path.node.id)) return;
        // Only remove if nested inside another function
        if (!path.parentPath?.getFunctionParent()) return;
        const parent = path.parentPath;
        const isFunctionBody =
          parent.isBlockStatement() && parent.parentPath?.isFunction() && parent.key === "body";
        // Sloppy block functions can expose an Annex B binding outside the block.
        if (!path.isInStrictMode() && (parent.isSwitchCase() || (parent.isBlockStatement() && !isFunctionBody))) {
          return;
        }
        const binding = parent.scope.getBinding(path.node.id.name);
        if (!binding || facts.observed(binding)) return;
        if (binding.referencePaths.length > 0) return;
        if (binding.constantViolations.length > 0) return;
        path.remove();
      },
    });

    return ast;
  },
};

/** Declarations instantiate before execution, even in a discarded branch/tail.
 * Inspect bindings at their declaration scopes, stopping at private function/class
 * bodies so a nested observer does not make an unrelated outer carrier live.
 */
function requiresDeclarationInstantiationRetention(candidate: any, facts: RuntimeNameFacts): boolean {
  let retained = false;
  const isExternal = (edge: any): boolean => {
    for (let path = edge; path; path = path.parentPath) {
      if (path === candidate) return false;
    }
    return true;
  };
  const inspect = (path: any): void => {
    let ids: Record<string, t.Identifier> = {};
    if (path.isVariableDeclarator()) ids = t.getBindingIdentifiers(path.node.id);
    else if (path.isFunctionDeclaration() || path.isClassDeclaration()) {
      if (path.node.id) ids = { [path.node.id.name]: path.node.id };
    } else if (path.isImportDeclaration()) ids = t.getBindingIdentifiers(path.node);
    for (const name of Object.keys(ids)) {
      let binding = path.scope.getBinding(name);
      if (path.isFunctionDeclaration()) {
        binding = path.parentPath?.scope.getBinding(name);
      } else if (
        path.isVariableDeclarator() &&
        path.parentPath?.isVariableDeclaration() &&
        path.parentPath.node.kind === "var"
      ) {
        const declarationScope = path.scope.getFunctionParent() ?? path.scope.getProgramParent();
        binding = declarationScope.getBinding(name);
      }
      if (facts.observed(binding)) retained = true;
      if (binding?.referencePaths.some(isExternal) || binding?.constantViolations.some(isExternal)) retained = true;
      if (path.isFunctionDeclaration()) {
        const owner = path.getFunctionParent() ?? path.findParent((p: any) => p.isProgram());
        if (facts.owners.get(name)?.has(owner)) retained = true;
      }
    }
  };
  inspect(candidate);
  if (!candidate.isFunction() && !candidate.isClass()) candidate.traverse({
    enter(path: any) {
      inspect(path);
      if (retained) path.stop();
      else if (path.isFunction() || path.isClass()) path.skip();
    },
  });
  return retained;
}

/** Check whether removing a block would leak a direct declaration into its parent scope. */
function hasScopeSensitiveDeclaration(block: t.BlockStatement): boolean {
  return block.body.some(
    stmt =>
      (t.isVariableDeclaration(stmt) && stmt.kind !== "var") ||
      t.isClassDeclaration(stmt) ||
      t.isFunctionDeclaration(stmt),
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
