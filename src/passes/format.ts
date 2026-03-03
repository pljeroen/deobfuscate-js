/**
 * Formatting pass — takes minified JS and produces readable,
 * properly indented output. Works at the token level, no AST needed.
 */

import { tokenize } from "../tokenizer.js";
import { TokenType, DeobfuscationPass } from "../types.js";
import type { Token } from "../types.js";

const INDENT = "  ";

const BINARY_OPS = new Set([
  "+", "-", "*", "/", "%", "**",
  "==", "!=", "===", "!==",
  "<", ">", "<=", ">=",
  "&&", "||", "??",
  "&", "|", "^", "<<", ">>", ">>>",
  "in", "instanceof",
]);

const ASSIGNMENT_OPS = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "**=",
  "&=", "|=", "^=", "<<=", ">>=", ">>>=",
  "&&=", "||=", "??=",
]);

const KEYWORD_SPACE = new Set([
  "if", "for", "while", "switch", "catch", "with",
]);

// Keywords that always need a space before the next token
const KEYWORD_NEEDS_SPACE = new Set([
  "return", "throw", "typeof", "delete", "void", "new",
  "case", "in", "instanceof", "of",
  "var", "let", "const", "class", "extends",
  "export", "import", "async", "await", "yield",
  "else", "do",
]);

// Tokens after which `-` or `+` is unary (not binary)
const UNARY_CONTEXT_PUNCTUATORS = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "**=",
  "&=", "|=", "^=", "<<=", ">>=", ">>>=",
  "&&=", "||=", "??=",
  "(", "[", ",", ";", ":", "?",
  "&&", "||", "??",
  "==", "!=", "===", "!==",
  "<", ">", "<=", ">=",
  "+", "-", "*", "/", "%", "**",
  "&", "|", "^", "~", "!",
  "<<", ">>", ">>>",
  "=>", "...",
  "{", "return",
]);

function indent(depth: number): string {
  return INDENT.repeat(depth);
}

function isWordLike(tok: Token): boolean {
  return (
    tok.type === TokenType.Identifier ||
    tok.type === TokenType.Keyword ||
    tok.type === TokenType.Number ||
    tok.type === TokenType.String ||
    tok.type === TokenType.RegExp ||
    tok.type === TokenType.Template
  );
}

/**
 * Determine if `-` or `+` at position i is unary based on the previous token.
 */
function isUnarySign(prevTok: Token | undefined): boolean {
  if (!prevTok) return true; // start of input
  if (prevTok.type === TokenType.Keyword) return true; // return -1, typeof -x
  if (prevTok.type === TokenType.Punctuator) {
    return UNARY_CONTEXT_PUNCTUATORS.has(prevTok.value);
  }
  return false;
}

export const formatPass: DeobfuscationPass = {
  name: "format",
  description: "Pretty-print minified code with proper indentation and line breaks",

  run(input: string): string {
    const tokens = tokenize(input).filter(
      (t) =>
        t.type !== TokenType.Whitespace &&
        t.type !== TokenType.LineTerminator
    );

    const out: string[] = [];
    let depth = 0;
    let lineStart = true;
    let parenDepth = 0;
    let bracketDepth = 0;
    let inForHeader = false;
    let ternaryDepth = 0;
    const ternaryStack: number[] = [];

    function lastEmitted(): string {
      return out[out.length - 1] ?? "";
    }

    function emit(s: string) {
      out.push(s);
      lineStart = false;
    }

    function newline() {
      const last = lastEmitted();
      if (last === "\n") return;
      out.push("\n");
      lineStart = true;
    }

    function emitIndent() {
      if (lineStart) {
        out.push(indent(depth));
        lineStart = false;
      }
    }

    function emitWordSep() {
      if (!lineStart) {
        const last = lastEmitted();
        if (last.length > 0 && last !== "\n" && last !== " " && !last.endsWith(" ") && !last.endsWith("(")) {
          emit(" ");
        }
      }
    }

    const significantTokens = tokens.filter((t) => t.type !== TokenType.EOF);

    let i = 0;
    for (; i < significantTokens.length; i++) {
      const tok = significantTokens[i];
      const prevTok = i > 0 ? significantTokens[i - 1] : undefined;

      // Track for-loop parentheses to suppress semicolon line breaks
      if (tok.type === TokenType.Keyword && tok.value === "for") {
        inForHeader = true;
      }

      if (tok.type === TokenType.Punctuator) {
        switch (tok.value) {
          case "{": {
            if (!lineStart) {
              const last = lastEmitted();
              if (last !== " " && !last.endsWith(" ")) {
                emit(" ");
              }
            }
            emitIndent();
            emit("{");
            depth++;
            ternaryStack.push(ternaryDepth);
            ternaryDepth = 0;
            newline();
            continue;
          }

          case "}": {
            depth--;
            ternaryDepth = ternaryStack.pop() ?? 0;
            newline();
            emitIndent();
            emit("}");
            const nextTok = significantTokens[i + 1];
            if (nextTok && nextTok.type === TokenType.Punctuator &&
                (nextTok.value === ";" || nextTok.value === ")" || nextTok.value === ",")) {
              // Don't newline — let the following token attach to }
            } else {
              newline();
            }
            continue;
          }

          case "(": {
            parenDepth++;
            ternaryStack.push(ternaryDepth);
            ternaryDepth = 0;
            emitIndent();
            emit("(");
            continue;
          }

          case ")": {
            parenDepth--;
            ternaryDepth = ternaryStack.pop() ?? 0;
            emit(")");
            if (inForHeader && parenDepth === 0) {
              inForHeader = false;
            }
            continue;
          }

          case "[": {
            bracketDepth++;
            emitIndent();
            emit("[");
            continue;
          }

          case "]": {
            bracketDepth--;
            emit("]");
            continue;
          }

          case ";": {
            emit(";");
            if (!inForHeader) {
              newline();
            } else {
              emit(" ");
            }
            continue;
          }

          case ",": {
            emit(",");
            if (depth > 0 && parenDepth === 0 && bracketDepth === 0) {
              newline();
            } else {
              emit(" ");
            }
            continue;
          }

          case "?": {
            emit(" ? ");
            ternaryDepth++;
            continue;
          }

          case ":": {
            if (ternaryDepth > 0) {
              ternaryDepth--;
              emit(" : ");
            } else {
              emit(": ");
            }
            continue;
          }

          case "=>": {
            emit(" => ");
            continue;
          }

          default: {
            // Space after keyword that needs it (return!, return-, return~)
            if (prevTok && prevTok.type === TokenType.Keyword && KEYWORD_NEEDS_SPACE.has(prevTok.value)) {
              emitWordSep();
            }

            if (ASSIGNMENT_OPS.has(tok.value)) {
              emit(" " + tok.value + " ");
              continue;
            }

            // Handle unary minus/plus: no spaces when unary
            if ((tok.value === "-" || tok.value === "+") && isUnarySign(prevTok)) {
              emitIndent();
              // Space was already emitted above if after keyword
              emit(tok.value);
              continue;
            }

            if (BINARY_OPS.has(tok.value)) {
              emit(" " + tok.value + " ");
              continue;
            }
            emitIndent();
            emit(tok.value);
            continue;
          }
        }
      }

      // Keywords that take a parenthesized condition — emit with trailing space
      if (tok.type === TokenType.Keyword && KEYWORD_SPACE.has(tok.value)) {
        emitIndent();
        emitWordSep();
        emit(tok.value);
        emit(" ");
        continue;
      }

      // All other tokens — handle word separation
      emitIndent();

      // After a keyword that needs space (return, throw, typeof, etc.)
      if (prevTok && prevTok.type === TokenType.Keyword && KEYWORD_NEEDS_SPACE.has(prevTok.value)) {
        emitWordSep();
      }
      // After a keyword from KEYWORD_SPACE that wasn't followed by ( — e.g. `if return`
      else if (prevTok && prevTok.type === TokenType.Keyword && KEYWORD_SPACE.has(prevTok.value)) {
        emitWordSep();
      }
      // Two adjacent word-like tokens
      else if (prevTok && isWordLike(tok) && isWordLike(prevTok)) {
        emitWordSep();
      }
      // After ) — keywords like return, if, etc. need space
      // e.g. `if (a)return false` → `if (a) return false`
      if (prevTok && prevTok.type === TokenType.Punctuator && prevTok.value === ")" && isWordLike(tok)) {
        emitWordSep();
      }

      emit(tok.value);
    }

    let result = out.join("");
    if (result.length > 0 && !result.endsWith("\n")) {
      result += "\n";
    }
    return result;
  },
};
