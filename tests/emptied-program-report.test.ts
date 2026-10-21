/**
 * Which pass emptied the program, and statement counts per pass run.
 *
 * runPipelineWithReport records, for every AST pass invocation, the top-level
 * statements plus directives before and after it, and names the invocation
 * that took a non-empty program to zero statements in an iteration that was
 * kept. The CLI names that pass in the emptied-program refusal and prints the
 * counts in the --verbose pass report.
 *
 * The pipeline-level cases use small synthetic passes; the CLI cases run the
 * real entry point.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { runPipelineWithReport } from "../src/pipeline.js";
import type { PassStatementCount } from "../src/pipeline.js";
import { t } from "../src/babel.js";
import { formatPass } from "../src/passes/format.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import type { ASTPass } from "../src/types.js";
import type { File } from "@babel/types";
import { TempDirs } from "./temp-dirs.js";
import { runCli, SPAWN_TIMEOUT } from "./program-checks.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const temps = new TempDirs();
afterAll(() => temps.removeAll());

const SRC = "var a = 1;\nconsole.log(a);\n";
const FOLDABLE = "var a = 1 + 2;\nconsole.log(a);\n";
// the discard warning names the iteration; parser warnings never do
const DISCARD = /^Discarded iteration \d+: /;

function pass(name: string, run: (ast: File) => File): ASTPass {
  return { name, description: "test pass", run };
}

/** A pass that acts only on the given invocations (1-based) of itself. */
function onInvocations(name: string, invocations: number[], act: (ast: File) => void): ASTPass {
  let n = 0;
  return pass(name, (ast) => {
    n++;
    if (invocations.includes(n)) act(ast);
    return ast;
  });
}

const empty = (ast: File): void => {
  ast.program.body = [];
  ast.program.directives = [];
};
const emptyKeepingBanner = (ast: File): void => {
  empty(ast);
  (ast.program as Any).innerComments = [{ type: "CommentBlock", value: " banner survives " }];
};
const addStatement = (label: string) => (ast: File): void => {
  ast.program.body.push(t.expressionStatement(t.identifier(label)) as Any);
};
/** Text the re-parse of the generated code can only partly parse. */
const addGarbage = (ast: File): void => {
  ast.program.body.push(t.expressionStatement(t.identifier("x;\n@@@")) as Any);
};

function astEntries(r: Any, tokenPassCount: number): Array<{ name: string; changed: boolean }> {
  return r.report.slice(0, r.report.length - tokenPassCount);
}

// ---------------------------------------------------------------------------
// pipeline level: attribution
// ---------------------------------------------------------------------------

describe("the pipeline names the pass invocation that emptied the program", () => {
  it("an invocation that empties the program in the first iteration", () => {
    const r: Any = runPipelineWithReport(SRC, [onInvocations("emptier", [1], empty)], [formatPass]);
    expect(r.finalStatementCount).toBe(0);
    expect(r.emptiedBy).toEqual({ name: "emptier", iteration: 1 });
  });

  it("an invocation that empties the program only in the second iteration", () => {
    const r: Any = runPipelineWithReport(FOLDABLE, [constantFoldPass, onInvocations("emptier", [2], empty)], [formatPass]);
    expect(r.finalStatementCount).toBe(0);
    expect(r.emptiedBy).toEqual({ name: "emptier", iteration: 2 });
  });

  it("an invocation that empties the program in the final iteration, after which no re-parse follows", () => {
    const r: Any = runPipelineWithReport(SRC, [
      onInvocations("grower", [1, 2], addStatement("GROWN")),
      onInvocations("emptier", [3], empty),
    ], []);
    expect(r.iterations).toBe(3);
    expect(r.finalStatementCount).toBe(0);
    expect(r.emptiedBy).toEqual({ name: "emptier", iteration: 3 });
  });

  it("when statements come back and the program is emptied again, the later invocation is named", () => {
    const r: Any = runPipelineWithReport(SRC, [
      onInvocations("first-emptier", [1], empty),
      onInvocations("refiller", [1], addStatement("REFILLED")),
      onInvocations("second-emptier", [2], empty),
    ], []);
    expect(r.finalStatementCount).toBe(0);
    expect(r.emptiedBy).toEqual({ name: "second-emptier", iteration: 2 });
  });

  it("an invocation that empties the program and then throws is undone and not named; its counts show the restored program", () => {
    const thrower = pass("empty-then-throw", (ast) => {
      empty(ast);
      throw new Error("emptied and failed");
    });
    const r: Any = runPipelineWithReport(SRC, [thrower], [formatPass]);
    expect(r.warnings).toContain("empty-then-throw: emptied and failed");
    expect(r.finalStatementCount).toBe(2);
    expect(r.passStatementCounts).toEqual([{ name: "empty-then-throw", iteration: 1, before: 2, after: 2 }]);
    expect("emptiedBy" in r).toBe(false);
  });

  it("an emptying invocation inside a discarded iteration is not named; the emptying invocation of the kept iteration is", () => {
    const r: Any = runPipelineWithReport(SRC, [
      onInvocations("banner-emptier", [1], emptyKeepingBanner),
      onInvocations("refiller", [2], addStatement("REFILLED")),
      onInvocations("late-emptier", [2], empty),
      onInvocations("garbler", [2], addGarbage),
    ], []);
    expect(r.warnings.filter((w: string) => DISCARD.test(w)), `warnings: ${JSON.stringify(r.warnings)}`).toHaveLength(1);
    expect(r.code).toContain("banner survives");
    expect(r.finalStatementCount).toBe(0);
    expect(r.emptiedBy).toEqual({ name: "banner-emptier", iteration: 1 });
    // the runs of the discarded iteration are still reported as observed
    expect(r.passStatementCounts).toContainEqual({ name: "late-emptier", iteration: 2, before: 1, after: 0 });
  });

  it("a run whose final program has statements carries counts and names no pass", () => {
    const r: Any = runPipelineWithReport(SRC, [
      onInvocations("emptier", [1], empty),
      onInvocations("refiller", [1], addStatement("REFILLED")),
    ], [formatPass]);
    expect(r.finalStatementCount).toBe(1);
    expect(r.passStatementCounts).toEqual([
      { name: "emptier", iteration: 1, before: 2, after: 0 },
      { name: "refiller", iteration: 1, before: 0, after: 1 },
      { name: "emptier", iteration: 2, before: 1, after: 1 },
      { name: "refiller", iteration: 2, before: 1, after: 1 },
    ]);
    expect("emptiedBy" in r).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pipeline level: counts
// ---------------------------------------------------------------------------

describe("the pipeline counts statements before and after every AST pass invocation", () => {
  it("one entry per AST invocation, in report order, with the 1-based iteration; report entries keep their shape", () => {
    const src = "var a = 1 + 2;\nif (false) { dead(); }\nconsole.log(a);\n";
    const r: Any = runPipelineWithReport(src, [constantFoldPass, deadCodeEliminatePass], [formatPass]);
    const expected: PassStatementCount[] = [
      { name: "constant-fold", iteration: 1, before: 3, after: 3 },
      { name: "dead-code-eliminate", iteration: 1, before: 3, after: 2 },
      { name: "constant-fold", iteration: 2, before: 2, after: 2 },
      { name: "dead-code-eliminate", iteration: 2, before: 2, after: 2 },
    ];
    expect(r.passStatementCounts).toEqual(expected);
    expect(r.passStatementCounts.map((c: Any) => c.name)).toEqual(astEntries(r, 1).map((e) => e.name));
    for (const e of r.report) expect(Object.keys(e).sort()).toEqual(["changed", "name"]);
  });

  it("a throwing invocation counts the restored program, and the next invocation starts from it", () => {
    const thrower = pass("thrower", (ast) => {
      ast.program.body.push(t.expressionStatement(t.identifier("INJECTED")) as Any);
      throw new Error("failed after adding a statement");
    });
    const r: Any = runPipelineWithReport(SRC, [thrower, onInvocations("emptier", [1], empty)], []);
    expect(r.passStatementCounts).toEqual([
      { name: "thrower", iteration: 1, before: 2, after: 2 },
      { name: "emptier", iteration: 1, before: 2, after: 0 },
    ]);
    expect(r.emptiedBy).toEqual({ name: "emptier", iteration: 1 });
  });
});

// ---------------------------------------------------------------------------
// CLI level
// ---------------------------------------------------------------------------

function cliOn(source: string, flags: string[] = []) {
  const d = temps.make("emptied-cli-");
  const input = join(d, "dead.js");
  const output = join(d, "out.js");
  fs.writeFileSync(input, source);
  return { input, output, r: runCli([...flags, input, output]) };
}

const AST_LINE = /^ {2}([\w-]+): (changed|no change) \(iteration (\d+), statements (\d+) → (\d+)\)$/;
const TOKEN_LINE = /^ {2}format: (changed|no change)$/;

/** The per-pass lines of the --verbose report, after "Pass report:". */
function reportLines(stderrLines: string[]): string[] {
  const start = stderrLines.indexOf("Pass report:");
  expect(start, `stderr:\n${stderrLines.join("\n")}`).toBeGreaterThan(0);
  expect(stderrLines[start - 1]).toMatch(/^Pipeline: \d+ iteration\(s\), entropy \d+\.\d\d → \d+\.\d\d$/);
  expect(stderrLines[start - 2]).toBe("");
  const rest = stderrLines.slice(start + 1);
  const end = rest.findIndex((l) => !l.startsWith("  "));
  return end === -1 ? rest : rest.slice(0, end);
}

function expectChainedCounts(astLines: string[]): void {
  for (let i = 1; i < astLines.length; i++) {
    const prev = AST_LINE.exec(astLines[i - 1])!;
    const cur = AST_LINE.exec(astLines[i])!;
    if (cur[3] === prev[3]) expect(cur[4], `${astLines[i - 1]} / ${astLines[i]}`).toBe(prev[5]);
  }
}

describe("the CLI names the pass that removed the last statement and reports counts per pass run", () => {
  it("refuses dead-code-only input with an ERROR line naming the pass and its iteration, writing nothing", () => {
    const { input, output, r } = cliOn("if (false) { x(); }\n");
    expect(r.signal).toBeNull();
    expect(r.status).toBe(1);
    expect(r.stderrLines[r.stderrLines.length - 1]).toBe(`ERROR: All statements were removed from the non-empty input ${input} by the dead-code-eliminate pass (iteration 1); nothing was written`);
    expect(r.stderrLines.filter((l) => l.startsWith("ERROR:"))).toHaveLength(1);
    expect(r.stdoutText).toBe("");
    expect(fs.existsSync(output)).toBe(false);
  }, SPAWN_TIMEOUT);

  it("--verbose prints iteration and statement counts on every AST pass line, the format line unchanged", () => {
    const { input, r } = cliOn("if (false) { x(); }\n", ["--verbose"]);
    expect(r.status).toBe(1);
    const report = reportLines(r.stderrLines);
    const astLines = report.slice(0, -1);
    expect(report[report.length - 1]).toMatch(TOKEN_LINE);
    expect(astLines.length).toBeGreaterThan(0);
    for (const line of astLines) expect(line).toMatch(AST_LINE);
    expect(astLines.find((l) => l.startsWith("  dead-code-eliminate: "))).toBe("  dead-code-eliminate: changed (iteration 1, statements 1 → 0)");
    expectChainedCounts(astLines);
    expect(r.stderrLines[r.stderrLines.length - 1]).toBe(`ERROR: All statements were removed from the non-empty input ${input} by the dead-code-eliminate pass (iteration 1); nothing was written`);
  }, SPAWN_TIMEOUT);

  it("--verbose numbers the iterations of a run that takes two", () => {
    const { r } = cliOn(FOLDABLE, ["--verbose"]);
    expect(r.status).toBe(0);
    const iterations = Number(/^Pipeline: (\d+) iteration/.exec(r.stderrLines.find((l) => l.startsWith("Pipeline: ")) ?? "")?.[1]);
    expect(iterations).toBe(2);
    const report = reportLines(r.stderrLines);
    const astLines = report.slice(0, -1);
    expect(report[report.length - 1]).toMatch(TOKEN_LINE);
    for (const line of astLines) expect(line).toMatch(AST_LINE);
    const seen = astLines.map((l) => Number(AST_LINE.exec(l)![3]));
    expect([...new Set(seen)]).toEqual([1, 2]);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(astLines.find((l) => l.startsWith("  constant-fold: "))).toBe("  constant-fold: changed (iteration 1, statements 2 → 2)");
    expectChainedCounts(astLines);
  }, SPAWN_TIMEOUT);
});
