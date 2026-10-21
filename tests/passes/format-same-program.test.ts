/**
 * The format pass's program-equality check, unit-tested on its own
 * (FORMAT-01 R-FM-01 AC-01.1 / AC-01.2, R-FM-16 AC-16.1 / AC-16.2).
 *
 * Pinned interface (TESTS_CANONICAL interface_pins IP-03, IP-04):
 *   src/passes/format.ts exports
 *     checkSameProgram(input, output): { same: true } | { same: false; reason: string }
 *     FORMAT_FALLBACK_REASONS: { notSameProgram, inputNotProgram } (the two reason texts)
 * checkSameProgram decides SAME(input, output) exactly as the requirements
 * define it (every goal the input parses under; trees without positions and
 * comment attachment; comment list; token sequence) and reports, when it
 * does not hold, "the formatted text is not the same program as its input",
 * or "the input does not parse as a program without errors" when the input
 * parses under no goal.
 *
 * Every table is also checked against the test-side reference
 * (tests/format-same-reference.ts), so a row that the reference itself
 * misjudges cannot hide a lenient or over-strict checker.
 */

import { describe, it, expect } from "vitest";
import * as formatModule from "../../src/passes/format.js";
import { CHECKER_WITNESSES, REASON_NOT_PROGRAM, REASON_NOT_SAME, SHAPE_CASES, referenceSame, shapeCase } from "../format-same-reference.js";
import type { PinnedFormatModule } from "../format-same-reference.js";

const pinned = formatModule as unknown as PinnedFormatModule;

function checker(): NonNullable<PinnedFormatModule["checkSameProgram"]> {
  const check = pinned.checkSameProgram;
  if (typeof check !== "function") throw new Error("src/passes/format.ts does not export checkSameProgram");
  return check;
}

/** Programs the check must reject: a defect-shape input with the base pass output, or a witness pair. */
const DEFECT_SHAPE_IDS = ["S1", "S1b", "S1c", "S2", "S3", "S3b", "S3d", "S4", "S4b", "S5", "S5b", "S6", "S7", "S8", "S8b", "S10", "S10b", "S11"];

/**
 * Two witnesses for "every goal": the input parses as script and as module;
 * the altered text is equal in every clause under one goal and differs under
 * the other. A check of only the first goal accepts one of them, whichever
 * goal it takes first. (W-html-goal is rejected by the token comparison
 * already under the script goal, so it does not witness this on its own.)
 */
const GOAL_WITNESSES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["W-goal-script-first", "out.push(await /x/g);\n", "out.push(await / x / g);\n", "equal under script; the altered text does not parse as module"],
  ["W-goal-module-first", "a = b <!--c;\nout.push(a);\n", "a = b <!--c\n;out.push(a);\n", "equal under module; comments and tokens differ under script"],
];

const REJECT: ReadonlyArray<readonly [string, string, string]> = [
  ...DEFECT_SHAPE_IDS.map((id) => [`${id} (base pass output)`, shapeCase(id).src, shapeCase(id).base] as const),
  ...CHECKER_WITNESSES.map(([id, x, y]) => [id, x, y] as const),
  ...GOAL_WITNESSES.map(([id, x, y]) => [id, x, y] as const),
];

/** The literal (input, expected) pairs of tests/passes/format.test.ts whose input is a program. */
const FORMAT_TEST_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["var a=1;var b=2;", "var a = 1;\nvar b = 2;\n"],
  ["function f(){return 1}", "function f() {\n  return 1\n}\n"],
  ["{a;b}", "{\n  a;\n  b\n}\n"],
  ["if(a){if(b){c}}", "if (a) {\n  if (b) {\n    c\n  }\n}\n"],
  ["function f(){if(a){b}}", "function f() {\n  if (a) {\n    b\n  }\n}\n"],
  ["a+b", "a + b\n"],
  ["a=1", "a = 1\n"],
  ["a===b", "a === b\n"],
  ["f(a,b,c)", "f(a, b, c)\n"],
  ["if(a){}", "if (a) {\n}\n"],
  ["function foo(){}", "function foo() {\n}\n"],
  ["for(var i=0;i<n;i++){x}", "for (var i = 0; i < n; i++) {\n  x\n}\n"],
  ["var o={a:1,b:2}", "var o = {\n  a: 1,\n  b: 2\n}\n"],
  ["function f(){}", "function f() {\n}\n"],
  ["return x", "return x\n"],
  ["if(a)return false;return true;", "if (a) return false;\nreturn true;\n"],
  ["return!x", "return !x\n"],
  ["return-1", "return -1\n"],
  ["return~x", "return ~x\n"],
  ["return\"hello\"", "return \"hello\"\n"],
  ["return 42", "return 42\n"],
  ["throw new Error()", "throw new Error()\n"],
  ["typeof x===\"string\"", "typeof x === \"string\"\n"],
  ["new Array(1)", "new Array(1)\n"],
  ["delete obj.x", "delete obj.x\n"],
  ["a?b:c", "a ? b : c\n"],
  ["x===y?1:0", "x === y ? 1 : 0\n"],
  ["a?b?c:d:e", "a ? b ? c : d : e\n"],
  ["var o={a:1}", "var o = {\n  a: 1\n}\n"],
  ["var a=[0,0,0,0]", "var a = [0, 0, 0, 0]\n"],
  ["function f(){var a=[1,2,3]}", "function f() {\n  var a = [1, 2, 3]\n}\n"],
  ["var f=function(){x};", "var f = function() {\n  x\n};\n"],
  ["(function(){x})()", "(function() {\n  x\n})()\n"],
  ["[function(){x},1]", "[function() {\n  x\n}, 1]\n"],
  ["x=-1", "x = -1\n"],
  ["f(a,-1)", "f(a, -1)\n"],
  ["(-1)", "(-1)\n"],
  ["a-b", "a - b\n"],
  // the "no crash on real input" snippet, with its formatted text
  [";(function(){function n(n,t,r){switch(n){case 1:return t;case 2:return r}}}).call(this);", ";\n(function() {\n  function n(n, t, r) {\n    switch (n) {\n      case 1: return t;\n      case 2: return r\n    }\n  }\n}).call(this);\n"],
  // the complete programs the two case-label tests use
  ["switch(n){case 1:return x}", "switch (n) {\n  case 1: return x\n}\n"],
  ["switch(n){case 1:return x;case 2:return a?b:c}", "switch (n) {\n  case 1: return x;\n  case 2: return a ? b : c\n}\n"],
];

/** Shape cases whose base pass output is already the same program. */
const CONTROL_IDS = ["S2b", "S2c", "S3c", "S5c", "S6b", "S6c", "S9", "S9b", "S12", "S13", "S14", "S15", "S16", "S17"];

const ACCEPT: ReadonlyArray<readonly [string, string, string]> = [
  ...FORMAT_TEST_PAIRS.map(([x, y]) => [`format.test.ts ${JSON.stringify(x)}`, x, y] as const),
  ["A-trailing-comma", "var o={a:1,};out.push(o.a);", "var o = {\n  a: 1,\n};\nout.push(o.a);\n"],
  ["A-empty", "", ""],
  ...CONTROL_IDS.map((id) => [`${id} (base pass output)`, shapeCase(id).src, shapeCase(id).base] as const),
];

describe("the reference SAME used by the format tests", () => {
  it("rejects every pair the check must reject", () => {
    const accepted = REJECT.filter(([, x, y]) => referenceSame(x, y).same).map(([id]) => id);
    expect(accepted).toEqual([]);
  });

  it("accepts every pair the check must accept", () => {
    const rejected = ACCEPT.filter(([, x, y]) => !referenceSame(x, y).same).map(([id, x, y]) => `${id}: ${referenceSame(x, y).detail}`);
    expect(rejected).toEqual([]);
  });

  it("covers every defect-shape case and control case exactly once", () => {
    const ids = [...DEFECT_SHAPE_IDS, ...CONTROL_IDS].sort();
    expect(ids).toEqual(SHAPE_CASES.map((c) => c.id).sort());
  });
});

describe("the reason texts", () => {
  it("exports the two fallback reasons with the texts the requirements state", () => {
    expect(pinned.FORMAT_FALLBACK_REASONS).toEqual({ notSameProgram: REASON_NOT_SAME, inputNotProgram: REASON_NOT_PROGRAM });
  });
});

describe("checkSameProgram rejects a different program (AC-01.1, AC-16.1)", () => {
  it.each(REJECT)("rejects %s", (_id, x, y) => {
    const verdict = checker()(x, y);
    expect(verdict.same).toBe(false);
    expect(verdict.reason).toBe(REASON_NOT_SAME);
  });

  it("reports an input that parses under no goal with the not-a-program reason", () => {
    const verdict = checker()("case 1:return x", "case 1: return x\n");
    expect(verdict.same).toBe(false);
    expect(verdict.reason).toBe(REASON_NOT_PROGRAM);
  });
});

describe("checkSameProgram accepts a re-spaced program (AC-01.2, AC-16.2)", () => {
  it.each(ACCEPT)("accepts %s", (_id, x, y) => {
    expect(checker()(x, y)).toMatchObject({ same: true });
  });
});
