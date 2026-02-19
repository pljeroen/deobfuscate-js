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

        // Only propagate literal values (no side effects)
        if (!isSimpleLiteral(init.node)) return;

        const id = path.get("id");
        if (!id.isIdentifier()) return;

        const binding = path.scope.getBinding(id.node.name);
        if (!binding) return;

        // Must not be reassigned
        if (binding.constantViolations.length > 0) return;

        // Must have references to inline into
        if (binding.referencePaths.length === 0) return;

        // Clone the literal value into each reference site
        for (const ref of binding.referencePaths) {
          if (ref.isIdentifier()) {
            ref.replaceWith(t.cloneNode(init.node));
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
