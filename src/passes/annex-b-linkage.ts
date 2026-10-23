import { traverse } from "../babel.js";
import type { File } from "@babel/types";

/** Babel bindings whose spelling supplies a retained Annex B block function at runtime. */
export function annexBLinkedBindings(ast: File): Set<unknown> {
  const linked = new Set<unknown>();
  traverse(ast, {
    FunctionDeclaration(path: any) {
      const { node, parentPath } = path;
      if (!node.id || node.async || node.generator || path.isInStrictMode()) return;

      const owner = path.getFunctionParent() ?? path.findParent((candidate: any) => candidate.isProgram());
      if (!owner) return;
      const belowAnnexBBoundary = parentPath.isSwitchCase()
        || (parentPath.isBlockStatement() && (!owner.isFunction() || parentPath.node !== owner.node.body));
      if (!belowAnnexBBoundary) return;

      const resolved = owner.scope.getBinding(node.id.name);
      if (!resolved) return;
      const sameOwnerKindQualifies = resolved.kind === "var"
        || resolved.kind === "hoisted"
        || resolved.kind === "local";
      if (resolved.scope === owner.scope && !sameOwnerKindQualifies) return;

      linked.add(resolved);
    },
  });

  return linked;
}
