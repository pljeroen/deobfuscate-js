/**
 * Test-side reference for the format pass's "same program" guarantee
 * (FORMAT-01 definitions.SAME), written independently of the production
 * checker so that the tests never judge the pass with the code under test.
 *
 * SAME(x, y) holds iff
 *   (a) x parses under at least one goal (script, module), and for every goal
 *       g under which x parses:
 *   (b) y parses under g and the two program trees are equal, comparing every
 *       node field except source positions (start, end, loc, range and the
 *       position-valued extra entries parenStart, trailingComma,
 *       trailingCommaLoc) and comment attachment (leadingComments,
 *       trailingComments, innerComments);
 *   (c) the ordered comment lists (kind, text) are equal;
 *   (d) the ordered token sequences (kind, value) are equal.
 * "Parses under g" means @babel/parser, with the pipeline's own options
 * (src/parser.ts) and error recovery off, throws no error and reports no
 * recovered error.
 *
 * Also here: a node:vm runner for execution corroboration, the reason texts,
 * and the defect-shape case table re-authored from the diagnosis probes
 * (inputs and the pass output at the base tree, e3963d7; the format pass and
 * the tokenizer are byte-identical to the c8c2f93 tree the probes ran on).
 */

import vm from "node:vm";
import { parse } from "@babel/parser";
import type { ParserOptions } from "@babel/parser";

export type Goal = "script" | "module";
export const GOALS: readonly Goal[] = ["script", "module"];

/** The fallback reasons and the warning texts, exactly as the requirements word them. */
export const REASON_NOT_SAME = "the formatted text is not the same program as its input";
export const REASON_NOT_PROGRAM = "the input does not parse as a program without errors";
export const PIPELINE_FALLBACK_PREFIX = "format: output left unformatted: ";
export const CLI_FALLBACK_PREFIX = "WARNING: format: output left unformatted: ";

const PARSER_OPTIONS: ParserOptions = {
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
  plugins: ["dynamicImport", "optionalChaining", "nullishCoalescingOperator"],
};

interface Parsed {
  program: unknown;
  comments: string[];
  tokens: string[];
  tokenLines: Array<{ kind: string; startLine: number; endLine: number }>;
}

const IGNORED_KEYS = new Set(["start", "end", "loc", "range", "leadingComments", "trailingComments", "innerComments"]);
const IGNORED_EXTRA_KEYS = new Set(["parenStart", "trailingComma", "trailingCommaLoc"]);

/** A JSON-safe, key-sorted copy without positions and comment attachment. */
function canonical(value: unknown, inExtra: boolean): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return value.map((v) => canonical(v, false));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (IGNORED_KEYS.has(key) || (inExtra && IGNORED_EXTRA_KEYS.has(key))) continue;
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

/** The text parsed under one goal, or undefined when it does not parse there without errors. */
export function parseUnder(text: string, goal: Goal): Parsed | undefined {
  let file: { program: unknown; comments?: unknown[]; tokens?: unknown[]; errors?: unknown[] };
  try {
    file = parse(text, { ...PARSER_OPTIONS, sourceType: goal, errorRecovery: false, tokens: true }) as unknown as typeof file;
  } catch (thrown) {
    if (thrown instanceof SyntaxError) return undefined;
    throw thrown;
  }
  if ((file.errors ?? []).length > 0) return undefined;
  const comments = (file.comments ?? []).map((c) => {
    const comment = c as { type: string; value: string };
    return `${comment.type}:${comment.value}`;
  });
  const rawTokens = (file.tokens ?? []) as Array<{ type: unknown; value?: unknown; loc: { start: { line: number }; end: { line: number } } }>;
  const tokens = rawTokens.map((t) => `${tokenKind(t)} ${JSON.stringify(canonical(t.value ?? null, false))}`);
  const tokenLines = rawTokens.map((t) => ({ kind: tokenKind(t), startLine: t.loc.start.line, endLine: t.loc.end.line }));
  return { program: JSON.stringify(canonical(file.program, false)), comments, tokens, tokenLines };
}

export interface SameVerdict {
  same: boolean;
  /** which clause decided, for failure messages */
  detail: string;
}

/** SAME(x, y) per definitions.SAME, clauses (a)-(d). */
export function referenceSame(input: string, output: string): SameVerdict {
  const goals = GOALS.filter((g) => parseUnder(input, g) !== undefined);
  if (goals.length === 0) return { same: false, detail: "(a) the input parses under no goal" };
  for (const goal of goals) {
    const x = parseUnder(input, goal)!;
    const y = parseUnder(output, goal);
    if (y === undefined) return { same: false, detail: `(b) the output does not parse as ${goal}` };
    if (x.program !== y.program) return { same: false, detail: `(b) the program trees differ (${goal})` };
    if (JSON.stringify(x.comments) !== JSON.stringify(y.comments)) return { same: false, detail: `(c) the comments differ (${goal})` };
    if (JSON.stringify(x.tokens) !== JSON.stringify(y.tokens)) return { same: false, detail: `(d) the token sequences differ (${goal})` };
  }
  return { same: true, detail: `same under ${goals.join(" and ")}` };
}

/** Each single-line comment of `output` that has a token after it on its own line (empty when none). */
export function tokensAfterLineComments(output: string): string[] {
  const parsed = GOALS.map((g) => parseUnder(output, g)).find((p) => p !== undefined);
  if (parsed === undefined) return ["the output does not parse"];
  const problems: string[] = [];
  parsed.tokenLines.forEach((tok, i) => {
    const next = parsed.tokenLines[i + 1];
    if (tok.kind === "CommentLine" && next !== undefined && next.kind !== "eof" && next.startLine === tok.endLine) {
      problems.push(`token ${next.kind} on line ${tok.endLine} after a single-line comment`);
    }
  });
  return problems;
}

/** The values the probe programs read. */
export const VM_INPUT = { n: 1, k: 2, x: "x y", t: "it's", b: "b", c: "c", s: "ab" };

/** Runs a program in a fresh node:vm context: the JSON of what it pushed to `out`, or the class of the error it threw. */
export function runInVm(code: string): string {
  const context = vm.createContext({ out: [] as unknown[], inp: { ...VM_INPUT } });
  try {
    vm.runInContext(code, context, { timeout: 2000 });
    return JSON.stringify(context.out);
  } catch (thrown) {
    const name = (thrown as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown";
    return `threw ${name}`;
  }
}

/** The text before the first line terminator (LF, CR, LS, PS). */
export function firstLine(text: string): string {
  const match = /[\n\r\u2028\u2029]/.exec(text);
  return match === null ? text : text.slice(0, match.index);
}

/**
 * The defect-shape probe programs (id, input, pass output at the base tree).
 * Each program pushes observable values into `out`; `inp` is VM_INPUT.
 */
export interface ShapeCase {
  id: string;
  src: string;
  base: string;
}

export const SHAPE_CASES: readonly ShapeCase[] = [
  { id: "S1", src: "// a\nout.push(1);\n", base: "// aout.push(1);\n" },
  { id: "S1b", src: "out.push(inp.n + // c\n 2);\n", base: "out.push(inp.n + // c2);\n" },
  { id: "S1c", src: "var x = 3;\nif (x > 2) {\n  // big\n  out.push('big');\n} else {\n  out.push('small');\n}\n", base: "var x = 3;\nif (x > 2) {\n  // bigout.push('big');\n}\nelse {\n  out.push('small');\n}\n" },
  { id: "S2", src: "out.push(1); // tail\nout.push(2);\n", base: "out.push(1);\n// tailout.push(2);\n" },
  { id: "S2b", src: "out.push(1);\n// end\n", base: "out.push(1);\n// end\n" },
  { id: "S2c", src: "// a\r\nout.push(1);\r\nout.push(2);\r\n", base: "// a\rout.push(1);\nout.push(2);\n" },
  { id: "S3", src: "if (inp.n) /(x) y/.test(inp.x);\nout.push(RegExp.$1);\n", base: "if (inp.n) / (x) y / .test(inp.x);\nout.push(RegExp.$1);\n" },
  { id: "S3b", src: "var n=inp.n;\nwhile (n--) /(x) y/.test(inp.x);\nout.push(RegExp.$1);\nfor (var i=0;i<inp.n;i++) /(x) /.test(inp.x);\nout.push(RegExp.$1);\n", base: "var n = inp.n;\nwhile (n--) / (x) y / .test(inp.x);\nout.push(RegExp.$1);\nfor (var i = 0; i < inp.n; i++) / (x) / .test(inp.x);\nout.push(RegExp.$1);\n" },
  { id: "S3c", src: "function f(){ out.push(inp.n); }\n/a b/.exec(inp.x), out.push('r');\n", base: "function f() {\n  out.push(inp.n);\n}\n/a b/.exec(inp.x), out.push('r');\n" },
  { id: "S3d", src: "if (inp.n) /(t)'s|x/.test(inp.t);\nout.push(RegExp.$1);\nout.push('z');\n", base: "if (inp.n) / (t) 's|x/.test(inp.t);\nout.push(RegExp.$1);\nout.push(' z ');\n" },
  { id: "S4", src: "var b=inp.b, c=inp.c;\nout.push(`a${`${b}${c}`}d`);\n", base: "var b = inp.b, c = inp.c;\nout.push(`a${` $ {\n  b\n}\n$ {\n  c\n}\n`}d`);\n" },
  { id: "S4b", src: "out.push(`a${\"`\"}b`);\n", base: "out.push(`a${\"` \"}b`);\n" },
  { id: "S5", src: "out.push(`8`/inp.k, 'x/a+b');\n", base: "out.push(`8` /inp.k, 'x/a + b ');\n" },
  { id: "S5b", src: "var o={default:inp.k*4, of:inp.k*3}; out.push(o.default / 2, 'x/a+b', o.of / 3, 'y/c+d');\n", base: "var o = {\n  default: inp.k * 4,\n  of: inp.k * 3\n};\nout.push(o.default / 2, 'x/a + b ', o.of / 3, ' y / c + d ');\n" },
  { id: "S5c", src: "out.push(function(){return inp.k*2}() / 2, 'x/a+b');\n", base: "out.push(function() {\n  return inp.k * 2\n}\n() / 2, 'x/a+b');\n" },
  { id: "S6", src: "function é(){ return 1; }\nout.push(é());\n", base: "functioné() {\n  return 1;\n}\nout.push(é());\n" },
  { id: "S6b", src: "var ñ=1, o={é:2};\nout.push(ñ + o.é, typeof ñ, 'é' in o);\n", base: "var ñ = 1, o = {\n  é: 2\n};\nout.push(ñ + o.é, typeof ñ, 'é' in o);\n" },
  { id: "S6c", src: "var a=1;var π=3;\nout.push(a ? π : 0);\nif (a) π;\nout.push(a in {1:1} ? π : 2);\nout.push(void π, a instanceof Object);\n", base: "var a = 1;\nvar π = 3;\nout.push(a ? π : 0);\nif (a)π;\nout.push(a in {\n  1: 1\n}\n ? π : 2);\nout.push(void π, a instanceof Object);\n" },
  { id: "S7", src: "out.push(inp.n + 1_000 + 0b1_0 + 0xF_F);\n", base: "out.push(inp.n + 1 _000 + 0b1 _0 + 0xF _F);\n" },
  { id: "S8", src: "var a=1\nvar b=2\nout.push(a+b)\n", base: "var a = 1 var b = 2 out.push(a + b)\n" },
  { id: "S8b", src: "function f(){ return\n 1 }\nout.push(f());\n", base: "function f() {\n  return 1\n}\nout.push(f());\n" },
  { id: "S9", src: "out.push(1 /* c */ + /* d */ 2);\nvar r = /* x */ 5;\nout.push(r);\n", base: "out.push(1/* c */ + /* d */2);\nvar r = /* x */5;\nout.push(r);\n" },
  { id: "S9b", src: "out.push(1 /* a\n b */ + 2);\n", base: "out.push(1/* a\n b */ + 2);\n" },
  { id: "S10", src: "<!-- html comment\nout.push(1);\n", base: " < !--html comment out.push(1);\n" },
  { id: "S10b", src: "out.push(1);\n--> html close\nout.push(2);\n", base: "out.push(1);\n-- > html close out.push(2);\n" },
  { id: "S11", src: "#!/usr/bin/env node\nout.push(1);\n", base: "#!/usr/bin /env node\nout.push(1);\n" },
  { id: "S12", src: "var a=inp.k*4,b=inp.k,c=inp.k;\nout.push((a)/b/c, a++ / b, [4][0]/2);\n", base: "var a = inp.k * 4, b = inp.k, c = inp.k;\nout.push((a) / b / c, a++ / b, [4][0] / 2);\n" },
  { id: "S13", src: "class A { static #p = 2; static s = 3; static async *g(){ yield 1; } m(){ return A.#p + A.s; } }\nout.push(new A().m());\n", base: "class A {\n  static#p = 2;\n  static s = 3;\n  static async  * g() {\n    yield 1;\n  }\n  m() {\n    return A.#p + A.s;\n  }\n}\nout.push(new A().m());\n" },
  { id: "S14", src: "var o=null;\nout.push(o?.a, o?.[1], 1?.5:2);\n", base: "var o = null;\nout.push(o?.a, o?.[1], 1?.5: 2);\n" },
  { id: "S15", src: "var o={if:1,class:2,new:3};\nout.push(o.if+o.class+o.new);\nL: for(;;){ break L; }\n", base: "var o = {\n  if : 1,\n  class: 2,\n  new: 3\n};\nout.push(o.if + o.class + o.new);\nL: for (; ; ) {\n  break L;\n}\n" },
  { id: "S16", src: "out.push('a\\\nb');\n", base: "out.push('a\\\nb');\n" },
  { id: "S17", src: "// a\u2028out.push(1);\nout.push(2);\n", base: "// a\u2028out.push(1);out.push(2);\n" },
];

export function shapeCase(id: string): ShapeCase {
  const found = SHAPE_CASES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no shape case ${id}`);
  return found;
}

/**
 * Programs that are the same except for one property SAME must see
 * (input, altered text, what decides).
 */
export const CHECKER_WITNESSES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["W-html-goal", "a = b <!-- c\nout.push(a);\n", "a = b; <!-- c\nout.push(a);\n", "x parses as script and module, the altered text only as script"],
  ["W-template-raw", "var b = 1; out.push(String.raw`a\\u0041`);\n", "var b = 1; out.push(String.raw`aA`);\n", "cooked values equal, raw values differ"],
  ["W-directive-paren", "'use strict'; try { undeclared = 1; out.push('sloppy'); } catch (e) { out.push('strict'); }\n", "('use strict'); try { undeclared = 1; out.push('sloppy'); } catch (e) { out.push('strict'); }\n", "a directive becomes an expression statement"],
  ["W-asi-return", "function f(){ return\n1 }\nout.push(f());\n", "function f(){ return 1 }\nout.push(f());\n", "a line break after return"],
  ["W-asi-postfix", "var a = 1, b = 1;\na\n++b\nout.push(a, b);\n", "var a = 1, b = 1;\na++\nb\nout.push(a, b);\n", "a line break before ++"],
  ["W-optional-paren", "var a = null; try { out.push(a?.b()); } catch (e) { out.push('threw'); }\n", "var a = null; try { out.push((a?.b)()); } catch (e) { out.push('threw'); }\n", "parentheses end an optional chain"],
  ["W-comment-text", "// keep\nout.push(1);\n", "// kept\nout.push(1);\n", "comment text (clause c only)"],
  ["W-hashbang", "#!/usr/bin/env node\nout.push(1);\n", "#!/usr/bin /env node\nout.push(1);\n", "the hashbang (program.interpreter)"],
  ["W-comment-move", "var a = 1, b = 2; out.push(a /* c */ + b);\n", "var a = 1, b = 2; out.push(a + /* c */ b);\n", "a comment moves relative to the tokens (clause d only)"],
];

/**
 * Texts the AST phase produces from inputs that parse only with error
 * recovery (early errors): the pipeline's format input for these runs parses
 * under neither goal without errors.
 */
export const RECOVERED_ERROR_INPUTS: readonly string[] = [
  "'use strict';\nwith (o) { out.push(1); }\n",
  "'use strict';\ndelete x;\nout.push(1);\n",
  "function f(a, a) { 'use strict'; return a; }\nout.push(f(1, 2));\n",
];

/** Public result and checking interface exposed by the format module and exercised by the tests. */
export interface PinnedFormatResult {
  text: string;
  fallbackReason?: string;
}
export interface PinnedFormatPass {
  name: string;
  run(input: string): string;
  runWithResult?: (input: string) => PinnedFormatResult;
  layout?: (input: string) => string;
}
export interface PinnedFormatModule {
  formatPass: PinnedFormatPass;
  checkSameProgram?: (input: string, output: string) => { same: boolean; reason?: string };
  FORMAT_FALLBACK_REASONS?: { notSameProgram?: string; inputNotProgram?: string };
}

/** Calls the pinned result member; a missing member is reported as a value so tests can name it. */
export function resultOf(pass: PinnedFormatPass, input: string): PinnedFormatResult | string {
  if (typeof pass.runWithResult !== "function") return "formatPass.runWithResult is not a function";
  return pass.runWithResult(input);
}
