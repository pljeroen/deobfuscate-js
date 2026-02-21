/**
 * AST-based variable renaming pass using Babel scope analysis.
 *
 * Replaces single-letter and two-letter minified variable names
 * with descriptive names from a fixed vocabulary.
 *
 * Uses Babel's scope tracking for correct lexical scoping,
 * hoisting, and closure handling.
 */

import { traverse } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

// Names that are conventional and should not be renamed
const KEEP_NAMES = new Set(["i", "j", "k", "x", "y", "z", "_", "$"]);

// Well-known globals that should never be renamed
const GLOBALS = new Set([
  "undefined", "null", "NaN", "Infinity",
  "console", "window", "global", "globalThis", "self",
  "document", "navigator", "location", "history",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "Promise", "Symbol", "Proxy", "Reflect",
  "Array", "Object", "String", "Number", "Boolean", "Function",
  "Map", "Set", "WeakMap", "WeakSet",
  "Error", "TypeError", "RangeError", "ReferenceError",
  "JSON", "Math", "Date", "RegExp",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent",
  "require", "module", "exports", "__dirname", "__filename",
  "arguments", "this",
]);

const DESCRIPTIVE_NAMES = [
  "value", "other", "result", "data", "key", "source",
  "object", "target", "predicate", "iteratee", "accumulator",
  "collection", "callback", "context", "args", "guard",
  "start", "end", "step", "depth", "customizer",
];

function shouldRename(name: string): boolean {
  if (name.length > 2) return false;
  if (KEEP_NAMES.has(name)) return false;
  if (GLOBALS.has(name)) return false;
  return true;
}

export const astRenamePass: ASTPass = {
  name: "ast-rename",
  description: "Rename single-letter variables using Babel scope analysis",

  run(ast: File): File {
    // Gate: only rename if obfuscated identifiers (_0x prefix) are present
    let hasObfuscated = false;
    traverse(ast, {
      Identifier(path) {
        if (path.node.name.startsWith("_0x")) {
          hasObfuscated = true;
          path.stop();
        }
      },
    });
    if (!hasObfuscated) return ast;

    traverse(ast, {
      "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression"(path) {
        const scope = path.scope;
        let nameIdx = 0;

        // Collect unbound references in this scope to avoid collisions
        const unboundNames = new Set<string>();
        path.traverse({
          Identifier(idPath) {
            if (idPath.isReferencedIdentifier() && !idPath.scope.hasBinding(idPath.node.name)) {
              unboundNames.add(idPath.node.name);
            }
          },
        });

        // Collect all bindings in this scope that need renaming
        const bindings = scope.bindings;

        for (const [name, binding] of Object.entries(bindings)) {
          if (!shouldRename(name)) continue;

          // Generate a new name that doesn't conflict
          let newName: string;
          do {
            newName = nameIdx < DESCRIPTIVE_NAMES.length
              ? DESCRIPTIVE_NAMES[nameIdx]
              : `var${nameIdx - DESCRIPTIVE_NAMES.length + 1}`;
            nameIdx++;
          } while (scope.hasBinding(newName) || GLOBALS.has(newName) || unboundNames.has(newName));

          // Use Babel's scope.rename for safe, correct renaming
          scope.rename(name, newName);
        }
      },
    });

    return ast;
  },
};
