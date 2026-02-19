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
    const renames = new Map<string, string>();
    const usedNames = new Set<string>();

    // Collect existing non-obfuscated names to avoid conflicts
    traverse(ast, {
      Identifier(path) {
        if (!isObfuscatedName(path.node.name)) {
          usedNames.add(path.node.name);
        }
      },
    });

    let counterIndex = 0;

    // Detect for-loop counters
    traverse(ast, {
      ForStatement(path) {
        const init = path.node.init;
        if (!t.isVariableDeclaration(init)) return;
        const decl = init.declarations[0];
        if (!t.isIdentifier(decl.id)) return;
        const name = decl.id.name;
        if (!isObfuscatedName(name) || renames.has(name)) return;

        // Pattern: var _0x = 0; _0x < N; _0x++
        if (!t.isNumericLiteral(decl.init) || decl.init.value !== 0) return;
        const test = path.node.test;
        if (!t.isBinaryExpression(test) || test.operator !== "<") return;
        const update = path.node.update;
        if (!t.isUpdateExpression(update) || update.operator !== "++") return;

        let newName: string;
        do {
          newName = counterIndex < COUNTER_NAMES.length
            ? COUNTER_NAMES[counterIndex]
            : `idx${counterIndex}`;
          counterIndex++;
        } while (usedNames.has(newName));

        renames.set(name, newName);
        usedNames.add(newName);
      },
    });

    // Detect .length assignments
    traverse(ast, {
      VariableDeclarator(path) {
        if (!t.isIdentifier(path.node.id)) return;
        const name = path.node.id.name;
        if (!isObfuscatedName(name) || renames.has(name)) return;

        const init = path.node.init;
        if (
          t.isMemberExpression(init) &&
          t.isIdentifier(init.property) &&
          init.property.name === "length"
        ) {
          let newName = "len";
          if (usedNames.has(newName)) newName = "length_";
          renames.set(name, newName);
          usedNames.add(newName);
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
        if (!isObfuscatedName(first.name) || renames.has(first.name)) return;

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
          const newName = usedNames.has("err") ? "error" : "err";
          renames.set(first.name, newName);
          usedNames.add(newName);
        }
      },
    });

    // Apply renames via scope API
    if (renames.size > 0) {
      traverse(ast, {
        Scope(path) {
          for (const [oldName, newName] of renames) {
            if (path.scope.hasOwnBinding(oldName)) {
              path.scope.rename(oldName, newName);
            }
          }
        },
      });
    }

    return ast;
  },
};
