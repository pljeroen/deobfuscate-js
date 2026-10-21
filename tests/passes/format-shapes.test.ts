/**
 * The format pass on the defect shapes, called directly (FORMAT-01 R-FM-03 to
 * R-FM-09, R-FM-13 controls, AC-01.4 execution corroboration).
 *
 * For a shape the pass must format, the output is the same program as the
 * input (tests/format-same-reference.ts), runs to the same result in a fresh
 * node:vm context, and the pass reports no fallback through its result member
 * formatPass.runWithResult(input) -> { text, fallbackReason? }
 * (TESTS_CANONICAL interface_pins IP-01, IP-02). For a raw-text-only shape the
 * pass returns its input unchanged and reports why. Control cases keep the
 * output the pass produced before this change, byte for byte.
 */

import { describe, it, expect } from "vitest";
import { formatPass } from "../../src/passes/format.js";
import { REASON_NOT_SAME, firstLine, referenceSame, resultOf, runInVm, shapeCase, tokensAfterLineComments } from "../format-same-reference.js";
import type { PinnedFormatPass } from "../format-same-reference.js";

const fp = formatPass as unknown as PinnedFormatPass;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** What is wrong with the pass's output for a program it must format (empty when nothing is). */
function formattedProblems(x: string): string[] {
  const problems: string[] = [];
  const y = fp.run(x);
  const same = referenceSame(x, y);
  if (!same.same) problems.push(`not the same program: ${same.detail}`);
  const ranX = runInVm(x);
  const ranY = runInVm(y);
  if (ranX !== ranY) problems.push(`the output runs to ${ranY}, the input to ${ranX}`);
  const result = resultOf(fp, x);
  if (typeof result === "string") {
    problems.push(result);
  } else {
    if (result.fallbackReason !== undefined) problems.push(`fell back: ${result.fallbackReason}`);
    if (result.text !== y) problems.push("runWithResult(x).text differs from run(x)");
  }
  return problems;
}

/** Problems per case id, only for the cases that have any. */
function problemsByCase(cases: ReadonlyArray<readonly [string, string]>, check: (x: string) => string[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [id, x] of cases) {
    const problems = check(x);
    if (problems.length > 0) found[id] = problems;
  }
  return found;
}

const fromShapes = (ids: string[]): Array<readonly [string, string]> => ids.map((id) => [id, shapeCase(id).src] as const);

describe("line comments (R-FM-03)", () => {
  // statement level, inside a block, inside an expression, before else, at end of input, CRLF,
  // and a comment ended by a lone CR, by LS and by PS
  const cases: Array<readonly [string, string]> = [
    ...fromShapes(["S1", "S1b", "S1c", "S2", "S2b", "S2c", "S17"]),
    ["S1d-before-else", "var a = 0;\nif (a) { out.push(1); } // c\nelse { out.push(2); }\n"],
    ["CR-ended", "out.push(1); // c\rout.push(2);\n"],
    ["LS-ended", `out.push(1); // c${LS}out.push(2);\n`],
    ["PS-ended", `out.push(1); // c${PS}out.push(2);\n`],
  ];

  it("formats every comment position and line-terminator kind into the same program, no token after a line comment on its line (AC-03.1)", () => {
    const found = problemsByCase(cases, (x) => [...formattedProblems(x), ...tokensAfterLineComments(fp.run(x))]);
    expect(found).toEqual({});
  });
});

describe("regular expression or division (R-FM-04)", () => {
  it("lexes '/' by syntactic context: regex after a control head, division after a template, a regex, a property name or undefined (AC-04.1)", () => {
    expect(problemsByCase(fromShapes(["S3", "S3b", "S3d", "S5", "S5b"]), formattedProblems)).toEqual({});
  });
});

describe("template literals (R-FM-05)", () => {
  it("keeps nested templates and a backtick inside a substitution (AC-05.1)", () => {
    expect(problemsByCase(fromShapes(["S4", "S4b"]), formattedProblems)).toEqual({});
    expect(runInVm(fp.run(shapeCase("S4").src))).toBe('["abcd"]');
    expect(runInVm(fp.run(shapeCase("S4b").src))).toBe('["a`b"]');
  });
});

describe("identifiers (R-FM-06)", () => {
  it("keeps a non-ASCII function name separate from the function keyword (AC-06.1)", () => {
    expect(problemsByCase(fromShapes(["S6"]), formattedProblems)).toEqual({});
    expect(runInVm(fp.run(shapeCase("S6").src))).toBe("[1]");
  });

  it("keeps the text of an escaped identifier (AC-06.2)", () => {
    const x = "var \\u0061bc=1;out.push(typeof abc,\\u0061bc);";
    const y = fp.run(x);
    expect(y).not.toBe(x);
    expect(y.split("\\u0061bc")).toHaveLength(3);
    expect(referenceSame(x, y)).toMatchObject({ same: true });
    expect(runInVm(y)).toBe(runInVm(x));
  });
});

describe("numeric separators (R-FM-07)", () => {
  it("keeps separators inside decimal, binary and hex literals (AC-07.1)", () => {
    expect(problemsByCase(fromShapes(["S7"]), formattedProblems)).toEqual({});
    expect(runInVm(fp.run(shapeCase("S7").src))).toBe("[1258]");
  });
});

describe("hashbang (R-FM-08)", () => {
  it("keeps the first line byte for byte, followed by a line terminator (AC-08.1)", () => {
    const x = shapeCase("S11").src;
    const y = fp.run(x);
    expect(firstLine(y)).toBe(firstLine(x));
    expect(y.slice(firstLine(x).length, firstLine(x).length + 1)).toMatch(/^[\n\r\u2028\u2029]$/);
    expect(problemsByCase([["S11", x]], formattedProblems)).toEqual({});
  });
});

describe("raw-text-only shapes (R-FM-09)", () => {
  it("leaves text whose meaning depends on line breaks or HTML-like comments unformatted, with the not-the-same-program reason (AC-09.1)", () => {
    const found = problemsByCase(fromShapes(["S8", "S8b", "S10", "S10b"]), (x) => {
      const problems: string[] = [];
      const y = fp.run(x);
      if (y !== x) problems.push(`run(x) is not x: ${JSON.stringify(y)}`);
      const result = resultOf(fp, x);
      if (typeof result === "string") problems.push(result);
      else if (result.text !== x || result.fallbackReason !== REASON_NOT_SAME) problems.push(`runWithResult(x) is ${JSON.stringify(result)}`);
      return problems;
    });
    expect(found).toEqual({});
  });
});

describe("control cases (R-FM-13)", () => {
  // inputs the pass already formatted into the same program before this change
  const controls = ["S2b", "S3c", "S5c", "S6b", "S6c", "S9", "S9b", "S12", "S13", "S14", "S15", "S16"];

  it.each(controls)("%s keeps its base output byte for byte and runs as the input does (AC-04.2, AC-06.2, AC-13.1, AC-01.4)", (id) => {
    const c = shapeCase(id);
    const y = fp.run(c.src);
    expect(y).toBe(c.base);
    expect(runInVm(y)).toBe(runInVm(c.src));
  });
});
