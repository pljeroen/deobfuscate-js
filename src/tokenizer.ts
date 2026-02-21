/**
 * JavaScript tokenizer — built from scratch.
 *
 * Breaks a JS source string into a stream of tokens.
 * Handles: identifiers, keywords, numbers, strings (single/double/template),
 * regex literals, punctuators, comments, and whitespace.
 */

import { Token, TokenType } from "./types.js";

const KEYWORDS = new Set([
  "break", "case", "catch", "continue", "debugger", "default", "delete",
  "do", "else", "finally", "for", "function", "if", "in", "instanceof",
  "new", "return", "switch", "this", "throw", "try", "typeof", "var",
  "void", "while", "with", "class", "const", "enum", "export", "extends",
  "import", "super", "implements", "interface", "let", "package", "private",
  "protected", "public", "static", "yield", "of", "async", "await",
  "null", "true", "false", "undefined",
]);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 0;

  function peek(): string {
    return source[pos] ?? "";
  }

  function advance(): string {
    const ch = source[pos++];
    if (ch === "\n") {
      line++;
      column = 0;
    } else {
      column++;
    }
    return ch;
  }

  function makeToken(type: TokenType, value: string, start: number, startLine: number, startCol: number): Token {
    return { type, value, start, end: pos, line: startLine, column: startCol };
  }

  while (pos < source.length) {
    const start = pos;
    const startLine = line;
    const startCol = column;
    const ch = peek();

    // Whitespace (non-newline)
    if (ch === " " || ch === "\t" || ch === "\r") {
      while (pos < source.length && (peek() === " " || peek() === "\t" || peek() === "\r")) {
        advance();
      }
      tokens.push(makeToken(TokenType.Whitespace, source.slice(start, pos), start, startLine, startCol));
      continue;
    }

    // Line terminators
    if (ch === "\n") {
      advance();
      tokens.push(makeToken(TokenType.LineTerminator, "\n", start, startLine, startCol));
      continue;
    }

    // Line comment
    if (ch === "/" && source[pos + 1] === "/") {
      advance(); advance();
      while (pos < source.length && peek() !== "\n") advance();
      tokens.push(makeToken(TokenType.LineComment, source.slice(start, pos), start, startLine, startCol));
      continue;
    }

    // Block comment
    if (ch === "/" && source[pos + 1] === "*") {
      advance(); advance();
      while (pos < source.length && !(peek() === "*" && source[pos + 1] === "/")) advance();
      advance(); advance(); // consume */
      tokens.push(makeToken(TokenType.BlockComment, source.slice(start, pos), start, startLine, startCol));
      continue;
    }

    // String literals
    if (ch === '"' || ch === "'") {
      const quote = advance();
      while (pos < source.length && peek() !== quote) {
        if (peek() === "\\") advance(); // skip escape
        advance();
      }
      advance(); // closing quote
      tokens.push(makeToken(TokenType.String, source.slice(start, pos), start, startLine, startCol));
      continue;
    }

    // Template literals
    if (ch === "`") {
      advance();
      while (pos < source.length && peek() !== "`") {
        if (peek() === "\\") advance();
        advance();
      }
      advance(); // closing backtick
      tokens.push(makeToken(TokenType.Template, source.slice(start, pos), start, startLine, startCol));
      continue;
    }

    // Numbers
    if (isDigit(ch) || (ch === "." && isDigit(source[pos + 1] ?? ""))) {
      if (ch === "0" && (source[pos + 1] === "x" || source[pos + 1] === "X")) {
        advance(); advance();
        while (pos < source.length && isHexDigit(peek())) advance();
      } else if (ch === "0" && (source[pos + 1] === "b" || source[pos + 1] === "B")) {
        advance(); advance();
        while (pos < source.length && (peek() === "0" || peek() === "1")) advance();
      } else if (ch === "0" && (source[pos + 1] === "o" || source[pos + 1] === "O")) {
        advance(); advance();
        while (pos < source.length && isOctalDigit(peek())) advance();
      } else {
        while (pos < source.length && isDigit(peek())) advance();
        if (peek() === ".") {
          advance();
          while (pos < source.length && isDigit(peek())) advance();
        }
        if (peek() === "e" || peek() === "E") {
          advance();
          if (peek() === "+" || peek() === "-") advance();
          while (pos < source.length && isDigit(peek())) advance();
        }
      }
      // BigInt suffix
      if (peek() === "n") advance();
      tokens.push(makeToken(TokenType.Number, source.slice(start, pos), start, startLine, startCol));
      continue;
    }

    // Identifiers & keywords
    if (isIdentStart(ch)) {
      while (pos < source.length && isIdentPart(peek())) advance();
      const value = source.slice(start, pos);
      const type = KEYWORDS.has(value) ? TokenType.Keyword : TokenType.Identifier;
      tokens.push(makeToken(type, value, start, startLine, startCol));
      continue;
    }

    // Regex literal (heuristic: / after certain tokens is division, otherwise regex)
    if (ch === "/" && canBeRegex(tokens)) {
      advance(); // opening /
      while (pos < source.length && peek() !== "/") {
        if (peek() === "\\") { advance(); advance(); continue; }
        if (peek() === "[") {
          advance();
          while (pos < source.length && peek() !== "]") {
            if (peek() === "\\") advance();
            advance();
          }
        }
        advance();
      }
      advance(); // closing /
      // flags
      while (pos < source.length && isIdentPart(peek())) advance();
      tokens.push(makeToken(TokenType.RegExp, source.slice(start, pos), start, startLine, startCol));
      continue;
    }

    // Multi-character punctuators (sorted longest-first)
    const remaining = source.slice(pos, pos + 4);
    const punct = matchPunctuator(remaining);
    if (punct) {
      for (let i = 0; i < punct.length; i++) advance();
      tokens.push(makeToken(TokenType.Punctuator, punct, start, startLine, startCol));
      continue;
    }

    // Single-character fallback
    advance();
    tokens.push(makeToken(TokenType.Punctuator, source.slice(start, pos), start, startLine, startCol));
  }

  tokens.push(makeToken(TokenType.EOF, "", pos, line, column));
  return tokens;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isOctalDigit(ch: string): boolean {
  return ch >= "0" && ch <= "7";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

const MULTI_PUNCTUATORS = [
  ">>>=", "===", "!==", ">>>", "<<=", ">>=", "**=", "&&=", "||=", "\?\?=",
  "&&", "||", "??", "==", "!=", "<=", ">=", "<<", ">>", "**",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "=>",
  "++", "--", "?.", "...",
];

function matchPunctuator(s: string): string | null {
  for (const p of MULTI_PUNCTUATORS) {
    if (s.startsWith(p)) return p;
  }
  return null;
}

/**
 * Keywords that produce a value (and thus / after them is division, not regex).
 * `this`, `true`, `false`, `null` evaluate to values — / after them is division.
 * Other keywords like `return`, `typeof`, `void`, `new`, `delete`, `throw`, `case`,
 * `in`, `instanceof` can precede regex.
 */
const VALUE_KEYWORDS = new Set(["this", "true", "false", "null"]);

function canBeRegex(tokens: Token[]): boolean {
  // After these tokens, / is division, not regex
  const lastSignificant = findLastSignificant(tokens);
  if (!lastSignificant) return true;
  if (lastSignificant.type === TokenType.Identifier) return false;
  if (lastSignificant.type === TokenType.Number) return false;
  if (lastSignificant.type === TokenType.String) return false;
  if (lastSignificant.type === TokenType.Punctuator) {
    return !["]", ")", "++", "--"].includes(lastSignificant.value);
  }
  if (lastSignificant.type === TokenType.Keyword) {
    // Value-producing keywords: / after them is division
    return !VALUE_KEYWORDS.has(lastSignificant.value);
  }
  return true;
}

function findLastSignificant(tokens: Token[]): Token | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type !== TokenType.Whitespace && t.type !== TokenType.LineTerminator && t.type !== TokenType.LineComment && t.type !== TokenType.BlockComment) {
      return t;
    }
  }
  return null;
}
