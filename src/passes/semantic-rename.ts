/**
 * Semantic variable renaming — renames obfuscated variables based on
 * their usage context rather than a fixed vocabulary.
 *
 * Detects patterns:
 * - For-loop counters → i, j, k, ...
 * - .length assignments → len
 * - Error-first callback first param → err
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

const HEX_PREFIX = /^_0x/;

const COUNTER_NAMES = ["i", "j", "k", "l", "m", "n"];

function isObfuscatedName(name: string): boolean {
  return HEX_PREFIX.test(name);
}

export const semanticRenamePass: ASTPass = {
  name: "semantic-rename",
  description: "Rename obfuscated variables based on usage context",

  run(ast: File): File {
    // Per-scope renames: maps binding uid to new name
    // This avoids the global map bug where the same old name in different scopes
    // gets the same new name even when those scopes should be independent.
    const scopeRenames = new Map<string, { oldName: string; newName: string }>();
    const globalUsedNames = new Set<string>();

    // Collect existing non-obfuscated names to avoid conflicts
    traverse(ast, {
      Identifier(path) {
        if (!isObfuscatedName(path.node.name)) {
          globalUsedNames.add(path.node.name);
        }
      },
    });

    // Track counter names assigned per function scope to avoid collisions
    // Key: function scope uid, Value: set of counter names already assigned
    const scopeCounterNames = new Map<string, Set<string>>();

    // Detect for-loop counters — per scope, so each function gets its own 'i'
    traverse(ast, {
      ForStatement(path) {
        const init = path.node.init;
        if (!t.isVariableDeclaration(init)) return;
        const decl = init.declarations[0];
        if (!t.isIdentifier(decl.id)) return;
        const name = decl.id.name;
        if (!isObfuscatedName(name)) return;

        const binding = path.scope.getBinding(name);
        if (!binding) return;
        // Use binding's identifier object identity as unique key
        const uid = `${name}@${binding.identifier.start}`;
        if (scopeRenames.has(uid)) return;

        // Pattern: var _0x = 0; _0x < N; _0x++
        if (!t.isNumericLiteral(decl.init) || decl.init.value !== 0) return;
        const test = path.node.test;
        if (!t.isBinaryExpression(test) || test.operator !== "<") return;
        const update = path.node.update;
        if (!t.isUpdateExpression(update) || update.operator !== "++") return;

        // Get the enclosing function scope for counter name tracking
        const fnParent = path.getFunctionParent();
        const scopeKey = fnParent ? String(fnParent.node.start ?? 0) : "program";
        if (!scopeCounterNames.has(scopeKey)) {
          scopeCounterNames.set(scopeKey, new Set<string>());
        }
        const usedCounters = scopeCounterNames.get(scopeKey)!;

        let counterIdx = 0;
        let newName: string;
        do {
          newName = counterIdx < COUNTER_NAMES.length
            ? COUNTER_NAMES[counterIdx]
            : `idx${counterIdx}`;
          counterIdx++;
        } while (globalUsedNames.has(newName) || usedCounters.has(newName));

        usedCounters.add(newName);
        scopeRenames.set(uid, { oldName: name, newName });
      },
    });

    // Detect .length assignments
    traverse(ast, {
      VariableDeclarator(path) {
        if (!t.isIdentifier(path.node.id)) return;
        const name = path.node.id.name;
        if (!isObfuscatedName(name)) return;

        const binding = path.scope.getBinding(name);
        if (!binding) return;
        const uid = `${name}@${binding.identifier.start}`;
        if (scopeRenames.has(uid)) return;

        const init = path.node.init;
        if (
          t.isMemberExpression(init) &&
          t.isIdentifier(init.property) &&
          init.property.name === "length"
        ) {
          const scopeUsed = getScopeUsedNames(path.scope);
          let newName = "len";
          if (globalUsedNames.has(newName) && scopeUsed.has(newName)) newName = "length_";
          scopeRenames.set(uid, { oldName: name, newName });
        }
      },
    });

    // Detect error-first callback parameters
    traverse(ast, {
      "FunctionDeclaration|FunctionExpression"(path: any) {
        const params = path.node.params;
        if (params.length < 2) return;
        const first = params[0];
        if (!t.isIdentifier(first)) return;
        if (!isObfuscatedName(first.name)) return;

        const binding = path.scope.getBinding(first.name);
        if (!binding) return;
        const uid = `${first.name}@${binding.identifier.start}`;
        if (scopeRenames.has(uid)) return;

        // Check if first param is thrown or used as if-test
        let isErrorParam = false;
        path.traverse({
          ThrowStatement(throwPath: any) {
            if (
              t.isIdentifier(throwPath.node.argument) &&
              throwPath.node.argument.name === first.name
            ) {
              isErrorParam = true;
            }
          },
          IfStatement(ifPath: any) {
            if (
              t.isIdentifier(ifPath.node.test) &&
              ifPath.node.test.name === first.name
            ) {
              isErrorParam = true;
            }
          },
        });

        if (isErrorParam) {
          const scopeUsed = getScopeUsedNames(path.scope);
          const newName = (globalUsedNames.has("err") && scopeUsed.has("err")) ? "error" : "err";
          scopeRenames.set(uid, { oldName: first.name, newName });
        }
      },
    });

    // Apply renames via scope API — each binding renamed independently
    if (scopeRenames.size > 0) {
      traverse(ast, {
        Scope(path) {
          for (const [uid, { oldName, newName }] of scopeRenames) {
            if (!path.scope.hasOwnBinding(oldName)) continue;
            const binding = path.scope.getBinding(oldName);
            if (!binding) continue;
            const bindingUid = `${oldName}@${binding.identifier.start}`;
            if (bindingUid === uid) {
              path.scope.rename(oldName, newName);
            }
          }
        },
      });
    }

    return ast;
  },
};

/** Get all names used in a scope's own bindings */
function getScopeUsedNames(scope: any): Set<string> {
  const names = new Set<string>();
  const bindings = scope.bindings || {};
  for (const name of Object.keys(bindings)) {
    names.add(name);
  }
  return names;
}
