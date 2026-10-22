/**
 * Formatting pass — takes minified JS and produces readable,
 * properly indented output. Works at the token level, no AST needed.
 */

import { Buffer } from "node:buffer";

import type { ParserOptions } from "@babel/parser";

import { parse as babelParse } from "../babel.js";
import { tokenize } from "../tokenizer.js";
import { TokenType } from "../types.js";
import type { Token, TokenPass, TokenPassResult } from "../types.js";

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

export const FORMAT_FALLBACK_REASONS = {
  notSameProgram: "the formatted text is not the same program as its input",
  inputNotProgram: "the input does not parse as a program without errors",
} as const;

type SameProgramVerdict =
  | { same: true }
  | { same: false; reason: typeof FORMAT_FALLBACK_REASONS[keyof typeof FORMAT_FALLBACK_REASONS] };

type ParseGoal = "script" | "module";

interface StrictParseFile {
  program: unknown;
  comments?: unknown[];
  tokens?: unknown[];
  errors?: unknown[];
}

interface StructuralSignature {
  chunks: readonly Buffer[];
  byteLength: number;
}

interface SignatureSink {
  writeByte(value: number): void;
  writeBytes(value: Buffer): void;
}

const PARSE_GOALS: readonly ParseGoal[] = ["script", "module"];
const STRICT_PARSE_OPTIONS: ParserOptions = {
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
  errorRecovery: false,
  plugins: ["dynamicImport", "optionalChaining", "nullishCoalescingOperator"],
  tokens: true,
};
const IGNORED_NODE_KEYS = new Set(["start", "end", "loc", "range", "leadingComments", "trailingComments", "innerComments"]);
const IGNORED_EXTRA_KEYS = new Set(["parenStart", "trailingComma", "trailingCommaLoc"]);
const SIGNATURE_CHUNK_BYTES = 64 * 1024;

const enum ValueTag {
  Null = 0,
  Undefined = 1,
  False = 2,
  True = 3,
  Number = 4,
  NonFiniteNumber = 5,
  BigInt = 6,
  String = 7,
  Array = 8,
  Object = 9,
}

const enum StringTag {
  New = 10,
  Reference = 11,
}

const enum SignatureSection {
  Program = 12,
  Comments = 13,
  Tokens = 14,
  End = 15,
}

class SignatureWriter implements SignatureSink {
  private readonly chunks: Buffer[] = [];
  private chunk = Buffer.allocUnsafe(SIGNATURE_CHUNK_BYTES);
  private offset = 0;
  private total = 0;

  writeByte(value: number): void {
    if (this.offset === this.chunk.length) this.flushFullChunk();
    this.chunk[this.offset++] = value;
    this.total++;
  }

  writeBytes(value: Buffer): void {
    let sourceOffset = 0;
    while (sourceOffset < value.length) {
      if (this.offset === this.chunk.length) this.flushFullChunk();
      const count = Math.min(value.length - sourceOffset, this.chunk.length - this.offset);
      value.copy(this.chunk, this.offset, sourceOffset, sourceOffset + count);
      sourceOffset += count;
      this.offset += count;
      this.total += count;
    }
  }

  finish(): StructuralSignature {
    if (this.offset > 0) this.chunks.push(this.chunk.subarray(0, this.offset));
    return { chunks: this.chunks, byteLength: this.total };
  }

  private flushFullChunk(): void {
    this.chunks.push(this.chunk);
    this.chunk = Buffer.allocUnsafe(SIGNATURE_CHUNK_BYTES);
    this.offset = 0;
  }
}

class SignatureComparator implements SignatureSink {
  private chunkIndex = 0;
  private chunkOffset = 0;
  private consumed = 0;
  private equal = true;

  constructor(private readonly expected: StructuralSignature) {}

  writeByte(value: number): void {
    if (!this.equal) return;
    const chunk = this.expected.chunks[this.chunkIndex];
    if (chunk === undefined || chunk[this.chunkOffset] !== value) {
      this.equal = false;
      return;
    }
    this.advance(1);
  }

  writeBytes(value: Buffer): void {
    if (!this.equal) return;
    let sourceOffset = 0;
    while (sourceOffset < value.length) {
      const chunk = this.expected.chunks[this.chunkIndex];
      if (chunk === undefined) {
        this.equal = false;
        return;
      }
      const count = Math.min(value.length - sourceOffset, chunk.length - this.chunkOffset);
      if (!value.subarray(sourceOffset, sourceOffset + count).equals(chunk.subarray(this.chunkOffset, this.chunkOffset + count))) {
        this.equal = false;
        return;
      }
      sourceOffset += count;
      this.advance(count);
    }
  }

  finish(): boolean {
    return this.equal && this.consumed === this.expected.byteLength;
  }

  private advance(count: number): void {
    this.chunkOffset += count;
    this.consumed += count;
    const chunk = this.expected.chunks[this.chunkIndex];
    if (chunk !== undefined && this.chunkOffset === chunk.length) {
      this.chunkIndex++;
      this.chunkOffset = 0;
    }
  }
}

function writeVarUint(sink: SignatureSink, value: number): void {
  let remaining = value;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    sink.writeByte(byte + (remaining > 0 ? 128 : 0));
  } while (remaining > 0);
}

type CanonicalFrame =
  | { kind: "value"; value: unknown; inExtra: boolean }
  | { kind: "array"; value: unknown[]; index: number }
  | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number };

class CanonicalEncoder {
  private readonly strings = new Map<string, number>();
  private readonly numberBytes = Buffer.allocUnsafe(8);

  constructor(private readonly sink: SignatureSink) {}

  writeString(value: string): void {
    const existing = this.strings.get(value);
    if (existing !== undefined) {
      this.sink.writeByte(StringTag.Reference);
      writeVarUint(this.sink, existing);
      return;
    }

    const id = this.strings.size;
    this.strings.set(value, id);
    const bytes = Buffer.from(value, "utf16le");
    this.sink.writeByte(StringTag.New);
    writeVarUint(this.sink, value.length);
    this.sink.writeBytes(bytes);
  }

  writeValue(value: unknown, inExtra: boolean): void {
    const stack: CanonicalFrame[] = [{ kind: "value", value, inExtra }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === "array") {
        if (frame.index < frame.value.length) {
          const index = frame.index;
          frame.index++;
          stack.push(frame, { kind: "value", value: frame.value[index], inExtra: false });
        }
        continue;
      }
      if (frame.kind === "object") {
        if (frame.index < frame.keys.length) {
          const key = frame.keys[frame.index];
          frame.index++;
          this.writeString(key);
          stack.push(frame, { kind: "value", value: frame.value[key], inExtra: key === "extra" });
        }
        continue;
      }

      const current = frame.value;
      if (current === null) {
        this.sink.writeByte(ValueTag.Null);
      } else if (current === undefined) {
        this.sink.writeByte(ValueTag.Undefined);
      } else if (current === false) {
        this.sink.writeByte(ValueTag.False);
      } else if (current === true) {
        this.sink.writeByte(ValueTag.True);
      } else if (typeof current === "number") {
        if (Number.isFinite(current)) {
          this.sink.writeByte(ValueTag.Number);
          this.numberBytes.writeDoubleBE(current);
          this.sink.writeBytes(this.numberBytes);
        } else {
          this.sink.writeByte(ValueTag.NonFiniteNumber);
          this.writeString(String(current));
        }
      } else if (typeof current === "bigint") {
        this.sink.writeByte(ValueTag.BigInt);
        this.writeString(current.toString());
      } else if (typeof current === "string") {
        this.sink.writeByte(ValueTag.String);
        this.writeString(current);
      } else if (Array.isArray(current)) {
        this.sink.writeByte(ValueTag.Array);
        writeVarUint(this.sink, current.length);
        stack.push({ kind: "array", value: current, index: 0 });
      } else if (typeof current === "object") {
        const source = current as Record<string, unknown>;
        const keys = Object.keys(source)
          .filter((key) => !IGNORED_NODE_KEYS.has(key) && !(frame.inExtra && IGNORED_EXTRA_KEYS.has(key)))
          .sort();
        this.sink.writeByte(ValueTag.Object);
        writeVarUint(this.sink, keys.length);
        stack.push({ kind: "object", value: source, keys, index: 0 });
      } else {
        throw new TypeError(`Unsupported parser value type: ${typeof current}`);
      }
    }
  }
}

function tokenKind(token: { type: unknown }): string {
  const type = token.type as string | { label?: string };
  return typeof type === "string" ? type : String(type.label);
}

function parseStrict(text: string, sourceType: ParseGoal): StrictParseFile | undefined {
  let file: StrictParseFile;
  try {
    file = babelParse(text, { ...STRICT_PARSE_OPTIONS, sourceType }) as unknown as typeof file;
  } catch (thrown: unknown) {
    if (thrown instanceof SyntaxError) return undefined;
    throw thrown;
  }
  if ((file.errors ?? []).length > 0) return undefined;

  return file;
}

function writeStrictParse(sink: SignatureSink, file: StrictParseFile): void {
  const encoder = new CanonicalEncoder(sink);
  sink.writeByte(SignatureSection.Program);
  encoder.writeValue(file.program, false);

  const comments = file.comments ?? [];
  sink.writeByte(SignatureSection.Comments);
  writeVarUint(sink, comments.length);
  for (const value of comments) {
    const comment = value as { type: string; value: string };
    encoder.writeString(comment.type);
    encoder.writeString(comment.value);
  }

  const tokens = file.tokens ?? [];
  sink.writeByte(SignatureSection.Tokens);
  writeVarUint(sink, tokens.length);
  for (const value of tokens) {
    const token = value as { type: unknown; value?: unknown };
    encoder.writeString(tokenKind(token));
    encoder.writeValue(token.value ?? null, false);
  }
  sink.writeByte(SignatureSection.End);
}

function strictSignature(text: string, sourceType: ParseGoal): StructuralSignature | undefined {
  const file = parseStrict(text, sourceType);
  if (file === undefined) return undefined;
  const writer = new SignatureWriter();
  writeStrictParse(writer, file);
  return writer.finish();
}

function matchesStrictSignature(text: string, sourceType: ParseGoal, expected: StructuralSignature): boolean {
  const file = parseStrict(text, sourceType);
  if (file === undefined) return false;
  const comparator = new SignatureComparator(expected);
  writeStrictParse(comparator, file);
  return comparator.finish();
}

/** Decide whether output is exactly the same program as input under every input parse goal. */
export function checkSameProgram(input: string, output: string): SameProgramVerdict {
  let acceptedInputGoal = false;
  for (const goal of PARSE_GOALS) {
    const signature = strictSignature(input, goal);
    if (signature === undefined) continue;
    acceptedInputGoal = true;
    if (!matchesStrictSignature(output, goal, signature)) {
      return { same: false, reason: FORMAT_FALLBACK_REASONS.notSameProgram };
    }
  }
  if (!acceptedInputGoal) return { same: false, reason: FORMAT_FALLBACK_REASONS.inputNotProgram };
  return { same: true };
}

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
  return INDENT.repeat(Math.max(0, depth));
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

type FormatPass = TokenPass & {
  layout(input: string): string;
  runWithResult(input: string): TokenPassResult;
};

function checkedFormat(input: string): TokenPassResult {
  const candidate = formatPass.layout(input);
  const verdict = checkSameProgram(input, candidate);
  return verdict.same ? { text: candidate } : { text: input, fallbackReason: verdict.reason };
}

function runFormat(input: string): string {
  return checkedFormat(input).text;
}

export const formatPass: FormatPass = {
  name: "format",
  description: "Pretty-print minified code with proper indentation and line breaks",

  run: runFormat,

  runWithResult(input: string): TokenPassResult {
    // Keep the established TokenPass failure seam observable when callers replace run,
    // as the pipeline's pass-failure contract permits for every token pass.
    if (formatPass.run !== runFormat) return { text: formatPass.run(input) };

    return checkedFormat(input);
  },

  layout(input: string): string {
    const rawTokens = tokenize(input);
    const tokens = rawTokens.filter((token, index) => {
      if (token.type === TokenType.Whitespace) return false;
      if (token.type !== TokenType.LineTerminator) return true;
      return index > 0 && rawTokens[index - 1].type === TokenType.LineComment;
    });

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
      const nextTok = significantTokens[i + 1];
      const controlKeywordIsProperty = tok.type === TokenType.Keyword && KEYWORD_SPACE.has(tok.value) &&
        prevTok?.type === TokenType.Punctuator && (prevTok.value === "." || prevTok.value === "?.");

      if (tok.type === TokenType.LineTerminator) {
        newline();
        continue;
      }

      // Track for-loop parentheses to suppress semicolon line breaks
      if (tok.type === TokenType.Keyword && tok.value === "for" && !controlKeywordIsProperty && nextTok?.value !== ":") {
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
            depth = Math.max(0, depth - 1);
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
            const beforePrevTok = i > 1 ? significantTokens[i - 2] : undefined;
            const keywordIsProperty = beforePrevTok?.type === TokenType.Punctuator &&
              (beforePrevTok.value === "." || beforePrevTok.value === "?.");
            const unarySign = !keywordIsProperty && (tok.value === "-" || tok.value === "+") && isUnarySign(prevTok);
            const operatorProvidesLeadingSpace = ASSIGNMENT_OPS.has(tok.value) ||
              (BINARY_OPS.has(tok.value) && !unarySign);
            if (prevTok && prevTok.type === TokenType.Keyword && KEYWORD_NEEDS_SPACE.has(prevTok.value) &&
                !(keywordIsProperty && operatorProvidesLeadingSpace)) {
              emitWordSep();
            }

            if (ASSIGNMENT_OPS.has(tok.value)) {
              emit(" " + tok.value + " ");
              continue;
            }

            // Handle unary minus/plus: no spaces when unary
            if (unarySign) {
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
      if (tok.type === TokenType.Keyword && KEYWORD_SPACE.has(tok.value) && !controlKeywordIsProperty) {
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
      if (prevTok && prevTok.type === TokenType.Punctuator && prevTok.value === ")" && isWordLike(tok) &&
          (tok.type !== TokenType.Identifier || /^[A-Za-z0-9_$]/.test(tok.value))) {
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
