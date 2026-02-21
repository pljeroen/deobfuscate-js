/**
 * Constant propagation pass — inlines variables assigned exactly once
 * to a constant (literal) value.
 *
 * Only propagates when:
 * - The binding is const, or var/let with exactly one assignment
 * - The initializer is a literal (number, string, boolean, null, undefined)
 * - The binding is not reassigned (no constantViolations)
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { NodePath } from "@babel/traverse";
import type { ASTPass } from "../types.js";

export const constantPropagatePass: ASTPass = {
  name: "constant-propagate",
  description: "Inline variables assigned once to constant values",

  run(ast: File): File {
    traverse(ast, {
      VariableDeclarator(path) {
        const init = path.get("init");
        if (!init.node) return;

        const id = path.get("id");
        if (!id.isIdentifier()) return;

        const binding = path.scope.getBinding(id.node.name);
        if (!binding) return;

        // Must not be reassigned
        if (binding.constantViolations.length > 0) return;

        // Must have references to inline into
        if (binding.referencePaths.length === 0) return;

        // Propagate literal values
        if (isSimpleLiteral(init.node)) {
          for (const ref of [...binding.referencePaths]) {
            if (ref.isIdentifier()) {
              ref.replaceWith(t.cloneNode(init.node));
            }
          }
          return;
        }

        // Propagate identifier aliases (const alias = original) when original is also constant.
        // Scope check: only replace at sites where the target resolves to the same binding,
        // to avoid semantic changes when the target name is shadowed in an inner scope.
        if (t.isIdentifier(init.node)) {
          const targetBinding = path.scope.getBinding(init.node.name);
          if (!targetBinding) return;
          if (targetBinding.constantViolations.length > 0) return;
          for (const ref of [...binding.referencePaths]) {
            if (!ref.isIdentifier()) continue;
            // Verify target resolves to the same binding at this reference site
            const refTargetBinding = ref.scope.getBinding(init.node.name);
            if (refTargetBinding !== targetBinding) continue;
            ref.replaceWith(t.cloneNode(init.node));
          }
          return;
        }

        // Propagate constant array element access: const arr = ["a", "b"]; arr[0] → "a"
        if (t.isArrayExpression(init.node) && isAllLiterals(init.node)) {
          // Verify no element mutations (arr[i] = value)
          const hasMutation = binding.referencePaths.some(ref => {
            const memberPath = ref.parentPath;
            if (!memberPath?.isMemberExpression() || memberPath.node.object !== ref.node) return false;
            const assignPath = memberPath.parentPath;
            return assignPath?.isAssignmentExpression() && assignPath.node.left === memberPath.node;
          });
          if (hasMutation) return;

          const elements = init.node.elements;
          let allReplaced = true;
          for (const ref of [...binding.referencePaths]) {
            const memberPath = ref.parentPath;
            if (!memberPath?.isMemberExpression() ||
                memberPath.node.object !== ref.node ||
                !memberPath.node.computed) {
              allReplaced = false;
              continue;
            }
            const prop = memberPath.node.property;
            if (!t.isNumericLiteral(prop)) { allReplaced = false; continue; }
            const idx = prop.value;
            if (idx < 0 || idx >= elements.length || !Number.isInteger(idx)) {
              allReplaced = false;
              continue;
            }
            const el = elements[idx];
            if (!el || t.isSpreadElement(el)) { allReplaced = false; continue; }
            memberPath.replaceWith(t.cloneNode(el));
          }
          if (allReplaced) {
            path.remove();
          }
        }
      },
    });

    // Phase 2: Cross-branch typeof folding
    traverse(ast, {
      UnaryExpression(path) {
        if (path.node.operator !== "typeof") return;
        if (!t.isIdentifier(path.node.argument)) return;

        const binding = path.scope.getBinding(path.node.argument.name);
        if (!binding) return;

        // Must have exactly 2 constant violations (assignments)
        if (binding.constantViolations.length !== 2) return;

        // Must not have a meaningful initializer (only bare `var x;` or `var x = undefined;`)
        if (binding.path.isVariableDeclarator()) {
          const init = binding.path.node.init;
          if (init && !(t.isIdentifier(init) && init.name === "undefined")) {
            return;
          }
        }

        const v0 = binding.constantViolations[0];
        const v1 = binding.constantViolations[1];

        // Both must be simple assignments
        if (!v0.isAssignmentExpression() || v0.node.operator !== "=") return;
        if (!v1.isAssignmentExpression() || v1.node.operator !== "=") return;

        // Both must be in branches of the same if/else
        const b0 = getIfBranch(v0);
        const b1 = getIfBranch(v1);
        if (!b0 || !b1) return;
        if (b0.ifNode !== b1.ifNode) return;
        if (b0.branch === b1.branch) return;

        // Both assigned values must have the same typeof class
        const t0 = typeofClass(v0.node.right);
        const t1 = typeofClass(v1.node.right);
        if (!t0 || !t1 || t0 !== t1) return;

        path.replaceWith(t.stringLiteral(t0));
      },
    });

    return ast;
  },
};

function isSimpleLiteral(node: t.Node): boolean {
  if (t.isNumericLiteral(node)) return true;
  if (t.isStringLiteral(node)) return true;
  if (t.isBooleanLiteral(node)) return true;
  if (t.isNullLiteral(node)) return true;
  if (t.isIdentifier(node) && node.name === "undefined") return true;
  return false;
}

function isAllLiterals(arr: t.ArrayExpression): boolean {
  return arr.elements.length > 0 && arr.elements.every(
    el => el !== null && !t.isSpreadElement(el) && isSimpleLiteral(el),
  );
}

/**
 * Walk up from a path to find the nearest IfStatement ancestor and
 * determine which branch (consequent or alternate) the path is in.
 */
function getIfBranch(path: NodePath): { ifNode: t.IfStatement; branch: "consequent" | "alternate" } | null {
  let current: NodePath | null = path;
  while (current && current.parentPath) {
    if (
      (current.key === "consequent" || current.key === "alternate") &&
      current.parentPath.isIfStatement()
    ) {
      return {
        ifNode: current.parentPath.node as t.IfStatement,
        branch: current.key as "consequent" | "alternate",
      };
    }
    current = current.parentPath;
  }
  return null;
}

/**
 * Determine the typeof class for a literal expression.
 */
function typeofClass(node: t.Expression): string | null {
  if (t.isStringLiteral(node)) return "string";
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return "string";
  if (t.isNumericLiteral(node)) return "number";
  if (t.isBooleanLiteral(node)) return "boolean";
  if (t.isNullLiteral(node)) return "object";
  if (t.isIdentifier(node) && node.name === "undefined") return "undefined";
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return "function";
  return null;
}
