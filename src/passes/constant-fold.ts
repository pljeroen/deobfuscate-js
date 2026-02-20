/**
 * Constant folding pass — evaluates static expressions at deobfuscation time.
 *
 * Targeted evaluation: only folds expressions where operands are already
 * literals or simple constant expressions. Avoids deep recursive evaluation
 * on large files.
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

export const constantFoldPass: ASTPass = {
  name: "constant-fold",
  description: "Evaluate static expressions to their constant values",

  run(ast: File): File {
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 25;

    // Iterate until no more changes (folding can expose new foldable expressions)
    while (changed && iterations < MAX_ITERATIONS) {
      changed = false;
      iterations++;

      traverse(ast, {
        // !0 -> true, !1 -> false, !true -> false, !false -> true,
        // typeof literal, void 0
        UnaryExpression(path) {
          const arg = path.node.argument;
          const op = path.node.operator;

          if (op === "!" && t.isNumericLiteral(arg)) {
            path.replaceWith(t.booleanLiteral(!arg.value));
            changed = true;
            return;
          }
          if (op === "!" && t.isBooleanLiteral(arg)) {
            path.replaceWith(t.booleanLiteral(!arg.value));
            changed = true;
            return;
          }
          if (op === "void" && t.isNumericLiteral(arg) && arg.value === 0) {
            path.replaceWith(t.identifier("undefined"));
            changed = true;
            return;
          }
          if (op === "typeof" && isSimpleLiteral(arg)) {
            const val = getLiteralValue(arg);
            if (val !== undefined || t.isIdentifier(arg)) {
              const typeStr = t.isIdentifier(arg) && arg.name === "undefined"
                ? "undefined"
                : typeof val;
              path.replaceWith(t.stringLiteral(typeStr));
              changed = true;
            }
          }
        },

        // Fold binary expressions where both sides are literals
        BinaryExpression(path) {
          const { left, right } = path.node;
          if (!isSimpleLiteral(left) || !isSimpleLiteral(right)) return;

          const lv = getLiteralValue(left);
          const rv = getLiteralValue(right);
          if (lv === undefined && !isUndefinedIdentifier(left)) return;
          if (rv === undefined && !isUndefinedIdentifier(right)) return;

          const result = evaluateBinary(path.node.operator, lv, rv);
          if (result === SKIP) return;

          replaceWithValue(path, result);
          changed = true;
        },

        // Fold logical expressions with literal operands
        LogicalExpression(path) {
          const left = path.node.left;
          if (!isSimpleLiteral(left)) return;

          const lv = getLiteralValue(left);
          const op = path.node.operator;

          if (op === "&&") {
            if (!lv) {
              path.replaceWith(left);
              changed = true;
            } else if (isSimpleLiteral(path.node.right)) {
              path.replaceWith(path.node.right);
              changed = true;
            }
          } else if (op === "||") {
            if (lv) {
              path.replaceWith(left);
              changed = true;
            } else if (isSimpleLiteral(path.node.right)) {
              path.replaceWith(path.node.right);
              changed = true;
            }
          }
        },

        // Fold ternary with constant test
        ConditionalExpression(path) {
          const test = path.node.test;
          if (!isSimpleLiteral(test)) return;

          const tv = getLiteralValue(test);
          if (tv) {
            path.replaceWith(path.node.consequent);
          } else {
            path.replaceWith(path.node.alternate);
          }
          changed = true;
        },
      });
    }

    return ast;
  },
};

const SKIP = Symbol("skip");

function isUndefinedIdentifier(node: t.Node): boolean {
  return t.isIdentifier(node) && node.name === "undefined";
}

function isSimpleLiteral(node: t.Node): boolean {
  if (t.isNumericLiteral(node)) return true;
  if (t.isStringLiteral(node)) return true;
  if (t.isBooleanLiteral(node)) return true;
  if (t.isNullLiteral(node)) return true;
  if (isUndefinedIdentifier(node)) return true;
  return false;
}

function getLiteralValue(node: t.Node): unknown {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (isUndefinedIdentifier(node)) return undefined;
  return undefined;
}

function evaluateBinary(op: string, lv: unknown, rv: unknown): unknown {
  switch (op) {
    case "+": {
      if (typeof lv === "number" && typeof rv === "number") return lv + rv;
      if (typeof lv === "string" && typeof rv === "string") return lv + rv;
      if (typeof lv === "string" || typeof rv === "string") return `${lv}${rv}`;
      return SKIP;
    }
    case "-": return typeof lv === "number" && typeof rv === "number" ? lv - rv : SKIP;
    case "*": return typeof lv === "number" && typeof rv === "number" ? lv * rv : SKIP;
    case "/": {
      if (typeof lv === "number" && typeof rv === "number") {
        if (rv === 0) return SKIP; // Don't fold division by zero
        return lv / rv;
      }
      return SKIP;
    }
    case "%": return typeof lv === "number" && typeof rv === "number" && rv !== 0 ? lv % rv : SKIP;
    case "**": return typeof lv === "number" && typeof rv === "number" ? lv ** rv : SKIP;
    case "===": return lv === rv;
    case "!==": return lv !== rv;
    case "==": return lv == rv;
    case "!=": return lv != rv;
    case "<": return typeof lv === "number" && typeof rv === "number" ? lv < rv : SKIP;
    case ">": return typeof lv === "number" && typeof rv === "number" ? lv > rv : SKIP;
    case "<=": return typeof lv === "number" && typeof rv === "number" ? lv <= rv : SKIP;
    case ">=": return typeof lv === "number" && typeof rv === "number" ? lv >= rv : SKIP;
    default: return SKIP;
  }
}

function replaceWithValue(path: { replaceWith(node: t.Expression): void }, value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return; // Don't fold to Infinity/NaN
    if (Object.is(value, -0)) return; // Don't fold -0 to 0 (1/-0 !== 1/0)
    if (value < 0) {
      path.replaceWith(t.unaryExpression("-", t.numericLiteral(-value)));
    } else {
      path.replaceWith(t.numericLiteral(value));
    }
  } else if (typeof value === "string") {
    path.replaceWith(t.stringLiteral(value));
  } else if (typeof value === "boolean") {
    path.replaceWith(t.booleanLiteral(value));
  } else if (value === undefined) {
    path.replaceWith(t.identifier("undefined"));
  } else if (value === null) {
    path.replaceWith(t.nullLiteral());
  }
}
