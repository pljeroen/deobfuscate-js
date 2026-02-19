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
    traverse(ast, {
      "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression"(path) {
        const scope = path.scope;
        let nameIdx = 0;

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
          } while (scope.hasBinding(newName) || GLOBALS.has(newName));

          // Use Babel's scope.rename for safe, correct renaming
          scope.rename(name, newName);
        }
      },
    });

    return ast;
  },
};
