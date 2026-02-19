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

        // Propagate identifier aliases (const alias = original) when original is also constant
        if (t.isIdentifier(init.node)) {
          const targetBinding = path.scope.getBinding(init.node.name);
          if (!targetBinding) return;
          if (targetBinding.constantViolations.length > 0) return;
          for (const ref of [...binding.referencePaths]) {
            if (ref.isIdentifier()) {
              ref.replaceWith(t.cloneNode(init.node));
            }
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
