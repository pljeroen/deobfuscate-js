/**
 * The format pass's fallback inside the pipeline (FORMAT-01 R-FM-01 AC-01.3,
 * R-FM-02 AC-02.1 / AC-02.2, R-FM-10 AC-10.2, R-FM-11 UX-FM-01).
 *
 * Public format-pass interface exercised by these tests:
 *   src/types.ts: TokenPassResult { text: string; fallbackReason?: string };
 *         TokenPass gains the optional member runWithResult?(input): TokenPassResult;
 *         run(input): string is unchanged.
 *   formatPass.runWithResult(x) returns { text, fallbackReason? };
 *         formatPass.run(x) === formatPass.runWithResult(x).text.
 *   formatPass.layout(x): the unchecked formatted text; runWithResult
 *         takes its candidate from formatPass.layout, looked up on the
 *         formatPass object at call time (a test double replaces it).
 *   The check parses with parse from "@babel/parser" (imported directly
 *         or through src/babel.ts), error recovery off; only the SyntaxError
 *         that parse throws becomes a result value, any other error propagates.
 *   runPipelineWithReport reads runWithResult when a token pass has it;
 *         on a fallback it records "format: output left unformatted: <reason>"
 *         and the report entry { name: "format", changed: false }.
 *         runPipeline and runTokenPipeline call run and get the unformatted
 *         text without a warning (no warning channel).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { filterSafePasses, runPipeline, runPipelineWithReport, runTokenPipeline } from "../src/pipeline.js";
import { allASTPasses } from "../src/cli-shared.js";
import { formatPass } from "../src/passes/format.js";
import type { ASTPass, TokenPass } from "../src/types.js";
import type { ParserOptions } from "@babel/parser";
const PASS_LISTS: ReadonlyArray<readonly ["default" | "--unsafe", ASTPass[]]> = [
  ["default", filterSafePasses(allASTPasses)],
  ["--unsafe", allASTPasses],
];
import {
  PIPELINE_FALLBACK_PREFIX,
  REASON_NOT_PROGRAM,
  REASON_NOT_SAME,
  RECOVERED_ERROR_INPUTS,
  referenceSame,
  resultOf,
  runInVm,
  shapeCase,
} from "./format-same-reference.js";
import type { PinnedFormatPass, PinnedFormatResult } from "./format-same-reference.js";

// Compile-safe test double for the anticipated IP-01 shape. Runtime tests below pin
// the production capability without adding diagnostics to the Base typecheck.
interface ExpectedTokenPassResult {
  text: string;
  fallbackReason?: string;
}

interface ExpectedTokenPass extends TokenPass {
  runWithResult(input: string): ExpectedTokenPassResult;
}

export const TOKEN_PASS_WITH_RESULT: ExpectedTokenPass = {
  name: "pinned-shape",
  description: "a token pass that reports its result",
  run: (input: string) => input,
  runWithResult: (input: string): ExpectedTokenPassResult => ({ text: input, fallbackReason: REASON_NOT_SAME }),
};

const ROOT = resolve(import.meta.dirname, "..");
const PIPELINE = join(ROOT, "src", "pipeline.ts");
const FORMAT = join(ROOT, "src", "passes", "format.ts");

const fp = formatPass as unknown as PinnedFormatPass;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function fields(result: PinnedFormatResult | string): unknown {
  return typeof result === "string" ? result : { text: result.text, fallbackReason: result.fallbackReason };
}

function formatWarnings(warnings: string[]): string[] {
  return warnings.filter((w) => w.startsWith("format: "));
}

afterEach(() => {
  vi.doUnmock("@babel/parser");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("text that is not a program leaves the AST-phase code unformatted (UX-FM-01, AC-10.2)", () => {
  const cases = RECOVERED_ERROR_INPUTS.flatMap((src, i) => PASS_LISTS.map(([mode, passes]) => [`trigger ${i + 1}`, mode, src, passes] as const));

  it.each(cases)("%s with the %s pass list: code is the AST-phase code, one last format warning, report no change", (_id, _mode, src, passes) => {
    const astPhase = runPipelineWithReport(src, passes, []);
    expect(astPhase.warnings.some((w) => w.startsWith("Parse error (recovered): "))).toBe(true);

    const r = runPipelineWithReport(src, passes, [formatPass]);
    expect(r.code).toBe(astPhase.code);
    expect(formatWarnings(r.warnings)).toEqual([PIPELINE_FALLBACK_PREFIX + REASON_NOT_PROGRAM]);
    expect(r.warnings).toEqual([...astPhase.warnings, PIPELINE_FALLBACK_PREFIX + REASON_NOT_PROGRAM]);
    expect(r.report[r.report.length - 1]).toEqual({ name: "format", changed: false });

    expect(fp.run(astPhase.code)).toBe(astPhase.code);
    expect(fields(resultOf(fp, astPhase.code))).toEqual({ text: astPhase.code, fallbackReason: REASON_NOT_PROGRAM });
  });
});

describe("plain callers get the unformatted text, without a warning or an exception (R-FM-11, CR-02)", () => {
  it("runPipeline and runTokenPipeline return the AST-phase code of text that is not a program", () => {
    const src = RECOVERED_ERROR_INPUTS[0];
    const unformatted = runPipeline(src, [], []);
    expect(runPipeline(src, [], [formatPass])).toBe(unformatted);
    expect(runTokenPipeline(unformatted, [formatPass])).toBe(unformatted);
  });
});

describe("a trailing line comment is formatted, not skipped (UX-FM-01)", () => {
  it.each(PASS_LISTS)("S2 with the %s pass list: no format warning, the code runs to [1,2]", (_mode, passes) => {
    const r = runPipelineWithReport(shapeCase("S2").src, passes, [formatPass]);
    expect(formatWarnings(r.warnings)).toEqual([]);
    expect(runInVm(r.code)).toBe("[1,2]");
  });
});

/** Removes the first line break after the first "//" (the D1 defect, re-created on correct output). */
function dropLineBreakAfterFirstComment(text: string): string {
  const start = text.indexOf("//");
  if (start < 0) return text;
  const match = /\r\n|[\n\r\u2028\u2029]/.exec(text.slice(start));
  if (match === null) return text;
  const at = start + match.index;
  return text.slice(0, at) + text.slice(at + match[0].length);
}

const CORRUPTING_DOUBLES: ReadonlyArray<readonly [string, (text: string) => string]> = [
  ["drops the line break after the first comment", dropLineBreakAfterFirstComment],
  ["appends a statement", (text) => `${text}out.push(2);\n`],
];

describe("the check guards every return path (AC-01.3, AC-02.1)", () => {
  it.each(CORRUPTING_DOUBLES)("a layout double that %s: the pass returns its input with the not-the-same-program reason, the pipeline keeps the AST-phase code", (_label, corrupt) => {
    const x = "// a\nout.push(1);\n";
    const layout = fp.layout;
    expect(typeof layout).toBe("function");
    const original = layout as (input: string) => string;
    expect(referenceSame(x, corrupt(original.call(fp, x))).same).toBe(false);

    const spy = vi.spyOn(fp as Required<PinnedFormatPass>, "layout").mockImplementation((input: string) => corrupt(original.call(fp, input)));

    expect(fp.run(x)).toBe(x);
    expect(fields(resultOf(fp, x))).toEqual({ text: x, fallbackReason: REASON_NOT_SAME });
    expect(spy).toHaveBeenCalled();

    const astPhase = runPipelineWithReport(x, [], []);
    const r = runPipelineWithReport(x, [], [formatPass]);
    expect(r.code).toBe(astPhase.code);
    expect(formatWarnings(r.warnings)).toEqual([PIPELINE_FALLBACK_PREFIX + REASON_NOT_SAME]);
    expect(r.warnings[r.warnings.length - 1]).toBe(PIPELINE_FALLBACK_PREFIX + REASON_NOT_SAME);
    expect(r.report[r.report.length - 1]).toEqual({ name: "format", changed: false });
  });
});

describe("an unexpected error inside the check (AC-02.2, CR-01)", () => {
  it("takes the existing token-pass failure channel: AST-phase code, one 'format: boom' warning, report no change", async () => {
    const src = "var a = 1;\nfunction f() { return a; }\n";
    const expected = runPipelineWithReport(src, [], []).code;
    const calls = { recovering: 0, strict: 0, poisoned: 0 };

    vi.resetModules();
    vi.doMock("@babel/parser", async (importOriginal) => {
      const orig = await importOriginal<typeof import("@babel/parser")>();
      return {
        ...orig,
        // The pipeline's own parses (error recovery on) pass through. A parse with error
        // recovery off returns the real tree with one statement field that throws when read,
        // so the parse call succeeds and the comparison of the trees throws.
        parse(text: string, options?: ParserOptions) {
          const file = orig.parse(text, options);
          if (options?.errorRecovery === true) {
            calls.recovering++;
            return file;
          }
          calls.strict++;
          const first = file.program.body[0] as unknown as Record<string, unknown> | undefined;
          if (first !== undefined) {
            const skip = new Set(["type", "start", "end", "loc", "range", "extra", "leadingComments", "trailingComments", "innerComments"]);
            const key = Object.keys(first).find((k) => !skip.has(k));
            if (key !== undefined) {
              Object.defineProperty(first, key, {
                enumerable: true,
                configurable: true,
                get() {
                  calls.poisoned++;
                  throw new Error("boom");
                },
              });
            }
          }
          return file;
        },
      };
    });
    const pipeline: Any = await import(/* @vite-ignore */ PIPELINE);
    const fmt: Any = (await import(/* @vite-ignore */ FORMAT)).formatPass;

    let r: Any;
    expect(() => {
      r = pipeline.runPipelineWithReport(src, [], [fmt]);
    }).not.toThrow();
    expect(calls.recovering).toBeGreaterThan(0);
    expect(r.code).toBe(expected);
    expect(formatWarnings(r.warnings)).toEqual(["format: boom"]);
    expect(r.report[r.report.length - 1]).toEqual({ name: "format", changed: false });
    expect(calls.strict).toBeGreaterThan(0);
    expect(calls.poisoned).toBeGreaterThan(0);
  });
});
