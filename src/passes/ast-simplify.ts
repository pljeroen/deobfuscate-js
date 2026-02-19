/**
 * AST-based simplification pass.
 *
 * - Splits comma expression statements into separate statements
 * - Converts computed member access with string literals to dot access
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
  description: "Split comma expressions and simplify member access",

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

    return ast;
  },
};
