/**
 * Semantic variable renaming — renames obfuscated variables based on
 * their usage context rather than a fixed vocabulary.
 *
 * Detects patterns:
 * - For-loop counters → i, j, k, ...
 * - .length assignments → len
 * - Error-first callback first param → err
 * - Array usage (.push, .pop, .forEach, .map, etc.) → arr
 * - JSON.parse() result → data
 * - RegExp usage (.test, .exec, assigned from regex) → pattern
 * - Arithmetic-only usage → num
 * - addEventListener callback param → event
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

const HEX_PATTERN = /_0x/;

const COUNTER_NAMES = ["i", "j", "k", "l", "m", "n"];

function isObfuscatedName(name: string): boolean {
  return HEX_PATTERN.test(name);
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
    // Track names already scheduled per scope to prevent duplicate assignments
    const scopeScheduledNames = new Map<string, Set<string>>();

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
          tryAssignCandidate(path, uid, name, ["len", "length_"], scopeRenames, globalUsedNames, scopeScheduledNames);
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
          tryAssignCandidate(path, uid, first.name, ["err", "error"], scopeRenames, globalUsedNames, scopeScheduledNames);
        }
      },
    });

    // Detect array usage: .push, .pop, .forEach, .map, .filter, .reduce, .splice, .slice
    detectUsagePattern(ast, scopeRenames, globalUsedNames, scopeScheduledNames, isArrayUsage, ["arr", "items", "list"]);

    // Detect JSON.parse result
    detectInitPattern(ast, scopeRenames, globalUsedNames, scopeScheduledNames, isJsonParseInit, ["data", "parsed"]);

    // Detect regex usage: assigned from regex literal, or .test/.exec called on it
    detectUsagePattern(ast, scopeRenames, globalUsedNames, scopeScheduledNames, isRegexUsage, ["pattern", "regex"]);

    // Detect arithmetic-only usage
    detectUsagePattern(ast, scopeRenames, globalUsedNames, scopeScheduledNames, isArithmeticUsage, ["num", "value"]);

    // Detect addEventListener callback event param
    detectEventParam(ast, scopeRenames, globalUsedNames, scopeScheduledNames);

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

/** Get all names bound in any scope from the given scope up to (and including)
 *  the enclosing function/program scope. This ensures var-hoisted names at the
 *  function scope are seen even when checking from a ForStatement scope. */
function getEffectiveScopeUsedNames(scope: any): Set<string> {
  const names = new Set<string>();
  let s = scope;
  while (s) {
    const bindings = s.bindings || {};
    for (const name of Object.keys(bindings)) {
      names.add(name);
    }
    // Stop after reaching function or program scope (the hoist target)
    if (s.path.isFunction() || s.path.isProgram()) break;
    s = s.parent;
  }
  return names;
}

// --- Type-informed pattern detection ---

const ARRAY_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "slice", "forEach", "map", "filter", "reduce", "find", "some", "every", "indexOf", "includes", "concat", "sort", "reverse", "flat", "flatMap"]);

const REGEX_METHODS = new Set(["test", "exec"]);
const STRING_REGEX_METHODS = new Set(["match", "search", "replace", "replaceAll"]);

/** Check if a binding is used primarily with array methods. */
function isArrayUsage(binding: any): boolean {
  let arrayMethodCount = 0;
  let totalRefs = 0;

  for (const ref of binding.referencePaths) {
    totalRefs++;
    const parent = ref.parent;
    // obj.method() where obj is the binding
    if (
      t.isMemberExpression(parent) &&
      t.isIdentifier(parent.property) &&
      ARRAY_METHODS.has(parent.property.name) &&
      ref.node === parent.object
    ) {
      arrayMethodCount++;
    }
  }

  return totalRefs > 0 && arrayMethodCount >= 1;
}

/** Check if initializer is JSON.parse(). */
function isJsonParseInit(binding: any): boolean {
  const declarator = binding.path.node;
  if (!t.isVariableDeclarator(declarator)) return false;
  const init = declarator.init;
  if (!t.isCallExpression(init)) return false;
  const callee = init.callee;
  return (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object) &&
    callee.object.name === "JSON" &&
    t.isIdentifier(callee.property) &&
    callee.property.name === "parse"
  );
}

/** Check if a binding is used primarily with regex methods or assigned from regex literal. */
function isRegexUsage(binding: any): boolean {
  // Assigned from regex literal
  const declarator = binding.path.node;
  if (t.isVariableDeclarator(declarator) && t.isRegExpLiteral(declarator.init)) {
    return true;
  }

  // Used with .test() or .exec()
  for (const ref of binding.referencePaths) {
    const parent = ref.parent;
    if (
      t.isMemberExpression(parent) &&
      t.isIdentifier(parent.property) &&
      REGEX_METHODS.has(parent.property.name) &&
      ref.node === parent.object
    ) {
      return true;
    }
    // Used as argument to string.match(), string.replace(), etc.
    const grandparent = ref.parentPath?.parent;
    if (
      t.isCallExpression(ref.parent) &&
      t.isMemberExpression((ref.parent as any).callee) &&
      t.isIdentifier((ref.parent as any).callee.property) &&
      STRING_REGEX_METHODS.has((ref.parent as any).callee.property.name)
    ) {
      return true;
    }
  }

  return false;
}

/** Check if a binding is used exclusively in arithmetic operations. */
function isArithmeticUsage(binding: any): boolean {
  const ARITH_OPS = new Set(["+", "-", "*", "/", "%", "**", "++", "--", "+=", "-=", "*=", "/="]);
  let arithmeticCount = 0;
  let totalRefs = 0;

  for (const ref of binding.referencePaths) {
    totalRefs++;
    const parent = ref.parent;
    if (t.isBinaryExpression(parent) && ARITH_OPS.has(parent.operator)) {
      arithmeticCount++;
    } else if (t.isUpdateExpression(parent)) {
      arithmeticCount++;
    } else if (t.isAssignmentExpression(parent) && ARITH_OPS.has(parent.operator)) {
      arithmeticCount++;
    }
  }

  // Must have at least 2 arithmetic uses and >50% of all uses
  return totalRefs >= 2 && arithmeticCount / totalRefs > 0.5;
}

/** Get the scope key for tracking scheduled names per scope. */
function getScopeKey(scope: any): string {
  const fnParent = scope.path.isProgram() ? scope.path : scope.path.getFunctionParent?.() ?? scope.path;
  return String(fnParent.node?.start ?? 0);
}

/** Try to assign a candidate name, checking both AST bindings and scheduled renames. */
function tryAssignCandidate(
  path: any,
  uid: string,
  oldName: string,
  candidates: string[],
  scopeRenames: Map<string, { oldName: string; newName: string }>,
  globalUsedNames: Set<string>,
  scopeScheduledNames: Map<string, Set<string>>,
): boolean {
  const scopeUsed = getEffectiveScopeUsedNames(path.scope);
  const scopeKey = getScopeKey(path.scope);
  const scheduled = scopeScheduledNames.get(scopeKey) ?? new Set<string>();

  for (const candidate of candidates) {
    if ((globalUsedNames.has(candidate) && scopeUsed.has(candidate)) || scheduled.has(candidate)) {
      continue;
    }
    scopeRenames.set(uid, { oldName, newName: candidate });
    if (!scopeScheduledNames.has(scopeKey)) {
      scopeScheduledNames.set(scopeKey, new Set<string>());
    }
    scopeScheduledNames.get(scopeKey)!.add(candidate);
    return true;
  }
  return false;
}

/** Detect variables matching a usage predicate and rename them. */
function detectUsagePattern(
  ast: File,
  scopeRenames: Map<string, { oldName: string; newName: string }>,
  globalUsedNames: Set<string>,
  scopeScheduledNames: Map<string, Set<string>>,
  predicate: (binding: any) => boolean,
  candidates: string[],
): void {
  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const name = path.node.id.name;
      if (!isObfuscatedName(name)) return;

      const binding = path.scope.getBinding(name);
      if (!binding) return;
      const uid = `${name}@${binding.identifier.start}`;
      if (scopeRenames.has(uid)) return;

      if (predicate(binding)) {
        tryAssignCandidate(path, uid, name, candidates, scopeRenames, globalUsedNames, scopeScheduledNames);
      }
    },
  });
}

/** Detect variables matching an initializer predicate and rename them. */
function detectInitPattern(
  ast: File,
  scopeRenames: Map<string, { oldName: string; newName: string }>,
  globalUsedNames: Set<string>,
  scopeScheduledNames: Map<string, Set<string>>,
  predicate: (binding: any) => boolean,
  candidates: string[],
): void {
  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const name = path.node.id.name;
      if (!isObfuscatedName(name)) return;

      const binding = path.scope.getBinding(name);
      if (!binding) return;
      const uid = `${name}@${binding.identifier.start}`;
      if (scopeRenames.has(uid)) return;

      if (predicate(binding)) {
        tryAssignCandidate(path, uid, name, candidates, scopeRenames, globalUsedNames, scopeScheduledNames);
      }
    },
  });
}

/** Detect addEventListener event parameter pattern. */
function detectEventParam(
  ast: File,
  scopeRenames: Map<string, { oldName: string; newName: string }>,
  globalUsedNames: Set<string>,
  scopeScheduledNames: Map<string, Set<string>>,
): void {
  traverse(ast, {
    CallExpression(path) {
      // Look for x.addEventListener("event", function(_0x...) {...})
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee)) return;
      if (!t.isIdentifier(callee.property) || callee.property.name !== "addEventListener") return;
      if (path.node.arguments.length < 2) return;

      const handler = path.node.arguments[1];
      if (!t.isFunctionExpression(handler) && !t.isArrowFunctionExpression(handler)) return;
      if (handler.params.length < 1) return;

      const param = handler.params[0];
      if (!t.isIdentifier(param) || !isObfuscatedName(param.name)) return;

      // Get the handler's scope — need to traverse into it
      const handlerPath = path.get("arguments.1") as any;
      if (!handlerPath || !handlerPath.scope) return;

      const binding = handlerPath.scope.getBinding(param.name);
      if (!binding) return;
      const uid = `${param.name}@${binding.identifier.start}`;
      if (scopeRenames.has(uid)) return;

      tryAssignCandidate(handlerPath, uid, param.name, ["event", "evt"], scopeRenames, globalUsedNames, scopeScheduledNames);
    },
  });
}
