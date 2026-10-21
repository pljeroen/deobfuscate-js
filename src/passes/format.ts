/**
 * Formatting pass — takes minified JS and produces readable,
 * properly indented output. Works at the token level, no AST needed.
 */

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

interface StrictParse {
  program: string;
  comments: string;
  tokens: string;
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

function canonical(value: unknown, inExtra: boolean): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return value.map((item) => canonical(item, false));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (IGNORED_NODE_KEYS.has(key) || (inExtra && IGNORED_EXTRA_KEYS.has(key))) continue;
      copy[key] = canonical(source[key], key === "extra");
    }
    return copy;
  }
  return value;
}

function tokenKind(token: { type: unknown }): string {
  const type = token.type as string | { label?: string };
  return typeof type === "string" ? type : String(type.label);
}

function parseStrict(text: string, sourceType: ParseGoal): StrictParse | undefined {
  let file: {
    program: unknown;
    comments?: unknown[];
    tokens?: unknown[];
    errors?: unknown[];
  };
  try {
    file = babelParse(text, { ...STRICT_PARSE_OPTIONS, sourceType }) as unknown as typeof file;
  } catch (thrown: unknown) {
    if (thrown instanceof SyntaxError) return undefined;
    throw thrown;
  }
  if ((file.errors ?? []).length > 0) return undefined;

  const comments = (file.comments ?? []).map((value) => {
    const comment = value as { type: string; value: string };
    return [comment.type, comment.value];
  });
  const tokens = (file.tokens ?? []).map((value) => {
    const token = value as { type: unknown; value?: unknown };
    return [tokenKind(token), canonical(token.value ?? null, false)];
  });
  return {
    program: JSON.stringify(canonical(file.program, false)),
    comments: JSON.stringify(comments),
    tokens: JSON.stringify(tokens),
  };
}

/** Decide whether output is exactly the same program as input under every input parse goal. */
export function checkSameProgram(input: string, output: string): SameProgramVerdict {
  const parsedInputs = PARSE_GOALS.map((goal) => [goal, parseStrict(input, goal)] as const)
    .filter((entry): entry is readonly [ParseGoal, StrictParse] => entry[1] !== undefined);
  if (parsedInputs.length === 0) return { same: false, reason: FORMAT_FALLBACK_REASONS.inputNotProgram };

  for (const [goal, parsedInput] of parsedInputs) {
    const parsedOutput = parseStrict(output, goal);
    if (parsedOutput === undefined || parsedOutput.program !== parsedInput.program || parsedOutput.comments !== parsedInput.comments || parsedOutput.tokens !== parsedInput.tokens) {
      return { same: false, reason: FORMAT_FALLBACK_REASONS.notSameProgram };
    }
  }
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

function runFormat(input: string): string {
  return formatPass.runWithResult(input).text;
}

export const formatPass: FormatPass = {
  name: "format",
  description: "Pretty-print minified code with proper indentation and line breaks",

  run: runFormat,

  runWithResult(input: string): TokenPassResult {
    // Keep the established TokenPass failure seam observable when callers replace run,
    // as the pipeline's pass-failure contract permits for every token pass.
    if (formatPass.run !== runFormat) return { text: formatPass.run(input) };

    const candidate = formatPass.layout(input);
    const verdict = checkSameProgram(input, candidate);
    return verdict.same ? { text: candidate } : { text: input, fallbackReason: verdict.reason };
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

      if (tok.type === TokenType.LineTerminator) {
        newline();
        continue;
      }

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
