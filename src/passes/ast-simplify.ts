/**
 * AST-based simplification pass.
 *
 * - Splits comma expression statements into separate statements
 * - Converts computed member access with string literals to dot access
 * - Converts logical expression statements to if-statements
 * - Converts ternary expression statements to if/else
 * - Merges else { if } into else-if
 * - Flips yoda conditions (literal === variable → variable === literal)
 * - Removes empty else blocks
 * - Inverts if with empty consequent and non-empty alternate
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

// Reserved words that can't be used as dot-access identifiers
const RESERVED = new Set([
  "break", "case", "catch", "continue", "debugger", "default", "delete",
  "do", "else", "finally", "for", "function", "if", "in", "instanceof",
  "new", "return", "switch", "this", "throw", "try", "typeof",
  "var", "void", "while", "with", "class", "const", "enum", "export",
  "extends", "import", "super", "implements", "interface", "let",
  "package", "private", "protected", "public", "static", "yield",
]);

export const astSimplifyPass: ASTPass = {
  name: "ast-simplify",
  description: "Split comma expressions, simplify member access, and unminify patterns",

  run(ast: File): File {
    // Pass 1: Split comma expression statements
    traverse(ast, {
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!t.isSequenceExpression(expr)) return;

        // Convert each expression in the sequence to a separate statement
        const statements = expr.expressions.map((e) =>
          t.expressionStatement(e)
        );
        path.replaceWithMultiple(statements);
      },
    });

    // Pass 2: Convert computed member access to dot access
    traverse(ast, {
      MemberExpression(path) {
        if (!path.node.computed) return;
        const prop = path.node.property;
        if (!t.isStringLiteral(prop)) return;

        const name = prop.value;
        if (!IDENTIFIER_RE.test(name)) return;
        if (RESERVED.has(name)) return;

        path.node.computed = false;
        path.node.property = t.identifier(name);
      },
    });

    // Pass 3: Unminify transforms
    traverse(ast, {
      // Logical expression statements → if-statements
      // a && b()  →  if (a) { b(); }
      // a || b()  →  if (!a) { b(); }
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!t.isLogicalExpression(expr)) return;
        if (expr.operator !== "&&" && expr.operator !== "||") return;

        const test = expr.operator === "&&"
          ? expr.left
          : t.unaryExpression("!", expr.left);
        const body = t.blockStatement([t.expressionStatement(expr.right)]);
        path.replaceWith(t.ifStatement(test, body));
      },

      // Ternary expression statements → if/else
      // a ? b() : c()  →  if (a) { b(); } else { c(); }
      ConditionalExpression(path) {
        // Only convert when the ternary is the entire expression statement
        if (!path.parentPath.isExpressionStatement()) return;

        const ifStmt = t.ifStatement(
          path.node.test,
          t.blockStatement([t.expressionStatement(path.node.consequent)]),
          t.blockStatement([t.expressionStatement(path.node.alternate)]),
        );
        path.parentPath.replaceWith(ifStmt);
      },

      // Merge else { if (...) {} } → else if (...) {}
      IfStatement(path) {
        const alt = path.node.alternate;
        if (!t.isBlockStatement(alt)) return;
        if (alt.body.length !== 1) return;
        if (!t.isIfStatement(alt.body[0])) return;
        path.node.alternate = alt.body[0];
      },

      // Flip yoda conditions: "str" === x → x === "str"
      BinaryExpression(path) {
        const { operator, left, right } = path.node;
        if (operator !== "===" && operator !== "!==" &&
            operator !== "==" && operator !== "!=") return;
        if (!isLiteral(left)) return;
        if (isLiteral(right)) return; // both literals — don't flip
        path.node.left = right;
        path.node.right = left;
      },
    });

    // Pass 4: Empty block cleanup (separate pass to run after pass 3 transforms)
    traverse(ast, {
      IfStatement(path) {
        const { consequent, alternate } = path.node;

        // Remove empty else: if (a) { b(); } else {} → if (a) { b(); }
        if (alternate && isEmptyBlock(alternate)) {
          path.node.alternate = null;
          return;
        }

        // Invert if with empty consequent: if (a) {} else { b(); } → if (!a) { b(); }
        if (isEmptyBlock(consequent) && alternate && !isEmptyBlock(alternate)) {
          path.node.test = t.unaryExpression("!", path.node.test);
          path.node.consequent = alternate;
          path.node.alternate = null;
        }
      },
    });

    return ast;
  },
};

function isLiteral(node: t.Node): boolean {
  return t.isNumericLiteral(node) || t.isStringLiteral(node) ||
         t.isBooleanLiteral(node) || t.isNullLiteral(node);
}

function isEmptyBlock(node: t.Node): boolean {
  return t.isBlockStatement(node) && node.body.length === 0;
}
