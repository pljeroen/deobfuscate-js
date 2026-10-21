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

const VALUE_KEYWORDS = new Set(["this", "super", "true", "false", "null", "undefined"]);
const CONTROL_HEAD_KEYWORDS = new Set(["if", "while", "for", "with", "switch", "catch"]);
const ID_START = /^[$_\p{ID_Start}]$/u;
const ID_CONTINUE = /^[$_\p{ID_Continue}]$/u;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 0;
  let regexAllowed = true;
  let pendingControlParen = false;
  let propertyNameExpected = false;
  const parenContexts: boolean[] = [];

  function peek(offset = 0): string {
    return source[pos + offset] ?? "";
  }

  function peekCodePoint(): string {
    const value = source.codePointAt(pos);
    return value === undefined ? "" : String.fromCodePoint(value);
  }

  function advance(): string {
    const ch = source[pos++] ?? "";
    if (ch === "\n" || ch === "\u2028" || ch === "\u2029" || (ch === "\r" && source[pos] !== "\n")) {
      line++;
      column = 0;
    } else {
      column++;
    }
    return ch;
  }

  function advanceCodePoint(): void {
    const cp = source.codePointAt(pos);
    if (cp === undefined) return;
    advance();
    if (cp > 0xffff) advance();
  }

  function makeToken(type: TokenType, value: string, start: number, startLine: number, startCol: number): Token {
    return { type, value, start, end: pos, line: startLine, column: startCol };
  }

  function updateContext(token: Token): void {
    if (token.type === TokenType.Whitespace || token.type === TokenType.LineTerminator || token.type === TokenType.LineComment || token.type === TokenType.BlockComment) {
      return;
    }

    const wasPropertyName = propertyNameExpected;
    if (token.type !== TokenType.Punctuator || (token.value !== "." && token.value !== "?.")) {
      propertyNameExpected = false;
    }

    if (token.type === TokenType.Identifier || token.type === TokenType.Number || token.type === TokenType.String || token.type === TokenType.Template || token.type === TokenType.RegExp) {
      pendingControlParen = false;
      regexAllowed = false;
      return;
    }

    if (token.type === TokenType.Keyword) {
      if (!wasPropertyName && CONTROL_HEAD_KEYWORDS.has(token.value)) {
        pendingControlParen = true;
        regexAllowed = true;
      } else {
        pendingControlParen = false;
        regexAllowed = wasPropertyName ? false : !VALUE_KEYWORDS.has(token.value);
      }
      return;
    }

    if (token.type !== TokenType.Punctuator) return;
    switch (token.value) {
      case "(":
        parenContexts.push(pendingControlParen);
        pendingControlParen = false;
        regexAllowed = true;
        return;
      case ")":
        regexAllowed = parenContexts.pop() === true;
        pendingControlParen = false;
        return;
      case "]":
      case "++":
      case "--":
        pendingControlParen = false;
        regexAllowed = false;
        return;
      case ".":
      case "?.":
        pendingControlParen = false;
        propertyNameExpected = true;
        regexAllowed = false;
        return;
      case "}":
        pendingControlParen = false;
        regexAllowed = true;
        return;
      default:
        pendingControlParen = false;
        regexAllowed = true;
    }
  }

  function pushToken(type: TokenType, start: number, startLine: number, startCol: number): void {
    const token = makeToken(type, source.slice(start, pos), start, startLine, startCol);
    tokens.push(token);
    updateContext(token);
  }

  function consumeLineTerminator(): void {
    if (peek() === "\r" && peek(1) === "\n") {
      advance();
      advance();
      return;
    }
    advance();
  }

  function consumeString(quote: string): void {
    advance();
    while (pos < source.length && peek() !== quote) {
      if (peek() === "\\") {
        advance();
        if (pos < source.length) advance();
      } else {
        advance();
      }
    }
    if (peek() === quote) advance();
  }

  function consumeLineComment(): void {
    advance();
    advance();
    while (pos < source.length && !isLineTerminator(peek())) advanceCodePoint();
  }

  function consumeBlockComment(): void {
    advance();
    advance();
    while (pos < source.length && !(peek() === "*" && peek(1) === "/")) advance();
    if (pos < source.length) {
      advance();
      advance();
    }
  }

  function consumeIdentifierEscape(): void {
    advance();
    if (peek() !== "u") return;
    advance();
    if (peek() === "{") {
      advance();
      while (pos < source.length && peek() !== "}") advance();
      if (peek() === "}") advance();
      return;
    }
    for (let i = 0; i < 4 && pos < source.length; i++) advance();
  }

  function consumeIdentifier(): void {
    if (isIdentifierEscape()) consumeIdentifierEscape();
    else advanceCodePoint();
    while (pos < source.length) {
      if (isIdentifierEscape()) consumeIdentifierEscape();
      else if (isIdentPart(peekCodePoint())) advanceCodePoint();
      else break;
    }
  }

  function consumeDigits(validDigit: (ch: string) => boolean): void {
    while (pos < source.length && (validDigit(peek()) || peek() === "_")) advance();
  }

  function consumeNumber(): void {
    if (peek() === "0" && (peek(1) === "x" || peek(1) === "X")) {
      advance();
      advance();
      consumeDigits(isHexDigit);
    } else if (peek() === "0" && (peek(1) === "b" || peek(1) === "B")) {
      advance();
      advance();
      consumeDigits((value) => value === "0" || value === "1");
    } else if (peek() === "0" && (peek(1) === "o" || peek(1) === "O")) {
      advance();
      advance();
      consumeDigits(isOctalDigit);
    } else {
      if (peek() !== ".") consumeDigits(isDigit);
      if (peek() === ".") {
        advance();
        consumeDigits(isDigit);
      }
      if (peek() === "e" || peek() === "E") {
        advance();
        if (peek() === "+" || peek() === "-") advance();
        consumeDigits(isDigit);
      }
    }
    if (peek() === "n") advance();
  }

  function consumeRegularExpression(): void {
    advance();
    let inClass = false;
    while (pos < source.length && !isLineTerminator(peek())) {
      if (peek() === "\\") {
        advance();
        if (pos < source.length) advance();
        continue;
      }
      if (peek() === "[") inClass = true;
      else if (peek() === "]") inClass = false;
      else if (peek() === "/" && !inClass) {
        advance();
        while (pos < source.length && (isIdentPart(peekCodePoint()) || isIdentifierEscape())) {
          if (isIdentifierEscape()) consumeIdentifierEscape();
          else advanceCodePoint();
        }
        return;
      }
      advance();
    }
  }

  function consumeTemplateExpression(): void {
    let braceDepth = 1;
    let expressionRegexAllowed = true;
    while (pos < source.length && braceDepth > 0) {
      const ch = peek();
      if (ch === '"' || ch === "'") {
        consumeString(ch);
        expressionRegexAllowed = false;
        continue;
      }
      if (ch === "`") {
        consumeTemplate();
        expressionRegexAllowed = false;
        continue;
      }
      if (ch === "/" && peek(1) === "/") {
        consumeLineComment();
        continue;
      }
      if (ch === "/" && peek(1) === "*") {
        consumeBlockComment();
        continue;
      }
      if (isLineTerminator(ch)) {
        consumeLineTerminator();
        continue;
      }
      if (/\s/u.test(ch)) {
        advance();
        continue;
      }
      if (isIdentStart(peekCodePoint()) || isIdentifierEscape()) {
        const wordStart = pos;
        consumeIdentifier();
        const word = source.slice(wordStart, pos);
        expressionRegexAllowed = KEYWORDS.has(word) ? !VALUE_KEYWORDS.has(word) : false;
        continue;
      }
      if (isDigit(ch) || (ch === "." && isDigit(peek(1)))) {
        consumeNumber();
        expressionRegexAllowed = false;
        continue;
      }
      if (ch === "/") {
        if (expressionRegexAllowed) {
          consumeRegularExpression();
          expressionRegexAllowed = false;
        } else {
          advance();
          if (peek() === "=") advance();
          expressionRegexAllowed = true;
        }
        continue;
      }
      if (ch === "{") {
        braceDepth++;
        advance();
        expressionRegexAllowed = true;
        continue;
      }
      if (ch === "}") {
        braceDepth--;
        advance();
        expressionRegexAllowed = false;
        continue;
      }
      if (ch === ")" || ch === "]") expressionRegexAllowed = false;
      else if (ch !== ".") expressionRegexAllowed = true;
      advance();
    }
  }

  function consumeTemplate(): void {
    advance();
    while (pos < source.length) {
      if (peek() === "\\") {
        advance();
        if (pos < source.length) advance();
        continue;
      }
      if (peek() === "`") {
        advance();
        return;
      }
      if (peek() === "$" && peek(1) === "{") {
        advance();
        advance();
        consumeTemplateExpression();
        continue;
      }
      advance();
    }
  }

  while (pos < source.length) {
    const start = pos;
    const startLine = line;
    const startCol = column;
    const ch = peek();

    if (ch === " " || ch === "\t" || ch === "\v" || ch === "\f") {
      while (pos < source.length && (peek() === " " || peek() === "\t" || peek() === "\v" || peek() === "\f")) advance();
      pushToken(TokenType.Whitespace, start, startLine, startCol);
      continue;
    }

    if (isLineTerminator(ch)) {
      consumeLineTerminator();
      pushToken(TokenType.LineTerminator, start, startLine, startCol);
      continue;
    }

    if (pos === 0 && ch === "#" && peek(1) === "!") {
      advance();
      advance();
      while (pos < source.length && !isLineTerminator(peek())) advanceCodePoint();
      pushToken(TokenType.LineComment, start, startLine, startCol);
      continue;
    }

    if (ch === "/" && peek(1) === "/") {
      consumeLineComment();
      pushToken(TokenType.LineComment, start, startLine, startCol);
      continue;
    }

    if (ch === "/" && peek(1) === "*") {
      consumeBlockComment();
      pushToken(TokenType.BlockComment, start, startLine, startCol);
      continue;
    }

    if (ch === '"' || ch === "'") {
      consumeString(ch);
      pushToken(TokenType.String, start, startLine, startCol);
      continue;
    }

    if (ch === "`") {
      consumeTemplate();
      pushToken(TokenType.Template, start, startLine, startCol);
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(peek(1)))) {
      consumeNumber();
      pushToken(TokenType.Number, start, startLine, startCol);
      continue;
    }

    if (isIdentStart(peekCodePoint()) || isIdentifierEscape()) {
      consumeIdentifier();
      const value = source.slice(start, pos);
      pushToken(KEYWORDS.has(value) ? TokenType.Keyword : TokenType.Identifier, start, startLine, startCol);
      continue;
    }

    if (ch === "/" && regexAllowed) {
      consumeRegularExpression();
      pushToken(TokenType.RegExp, start, startLine, startCol);
      continue;
    }

    const punct = matchPunctuator(source.slice(pos, pos + 4));
    if (punct) {
      for (let i = 0; i < punct.length; i++) advance();
      pushToken(TokenType.Punctuator, start, startLine, startCol);
      continue;
    }

    advance();
    pushToken(TokenType.Punctuator, start, startLine, startCol);
  }

  tokens.push(makeToken(TokenType.EOF, "", pos, line, column));
  return tokens;

  function isIdentifierEscape(): boolean {
    return peek() === "\\" && peek(1) === "u";
  }
}

function isLineTerminator(ch: string): boolean {
  return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
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
  return ch !== "" && ID_START.test(ch);
}

function isIdentPart(ch: string): boolean {
  return ch !== "" && (ID_CONTINUE.test(ch) || isDigit(ch));
}

const MULTI_PUNCTUATORS = [
  ">>>=", "===", "!==", ">>>", "<<=", ">>=", "**=", "&&=", "||=", "??=",
  "&&", "||", "??", "==", "!=", "<=", ">=", "<<", ">>", "**",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "=>",
  "++", "--", "?.", "...",
];

function matchPunctuator(source: string): string | null {
  for (const punctuator of MULTI_PUNCTUATORS) {
    if (source.startsWith(punctuator)) return punctuator;
  }
  return null;
}
