/**
 * Pipeline runner and parser: structured parse outcome, transactional pass
 * skip, inter-iteration re-parse discard, and the unexpected-error catch.
 *
 * Result fields these tests rely on (additive; base fields unchanged):
 *   ParseResult:    completeness: "whole" | "truncated" | "empty";
 *                   mode: "module-capable" | "script-fallback";
 *                   recoveredErrors: number; truncatedAtLine?: number
 *   PipelineResult: initialParse: { completeness, mode, recoveredErrors, truncatedAtLine? };
 *                   inputStatementCount: number;  // Count(A0) = body.length + directives.length
 *                   finalStatementCount: number;  // Count(A_final)
 *   An unexpected error thrown out of runPipelineWithReport carries the
 *   warnings collected so far in a `warnings` array property.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { runPipelineWithReport, runPipeline, runASTPipeline } from "../src/pipeline.js";
import { parseWithDiagnostics } from "../src/parser.js";
import { t } from "../src/babel.js";
import { formatPass } from "../src/passes/format.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import type { ASTPass, TokenPass, PipelineContext } from "../src/types.js";
import type { File } from "@babel/types";

const ROOT = resolve(import.meta.dirname, "..");
const BABEL_FACADE = join(ROOT, "src", "babel.ts");
const PARSER = join(ROOT, "src", "parser.ts");
const PIPELINE = join(ROOT, "src", "pipeline.ts");
const ENTROPY = join(ROOT, "src", "entropy.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function pass(name: string, run: (ast: File, source?: string, context?: PipelineContext) => File): ASTPass {
  return { name, description: "test pass", run };
}

function syntaxErrorAt(line: number): SyntaxError {
  const e = new SyntaxError(`stub syntax error (${line}:0)`) as SyntaxError & { loc: { line: number; column: number } };
  e.loc = { line, column: 0 };
  return e;
}

afterEach(() => {
  vi.doUnmock(BABEL_FACADE);
  vi.doUnmock(PARSER);
  vi.doUnmock(ENTROPY);
  vi.resetModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// FC-111 / FC-115 structured parse outcome
// ---------------------------------------------------------------------------

describe("structured parse outcome (FC-111, FC-115, CS-02)", () => {
  it("reports completeness, mode, recoveredErrors and truncatedAtLine for real inputs, base fields unchanged", () => {
    const clean: Any = parseWithDiagnostics("var a = 1;");
    expect(clean.warnings).toEqual([]);
    expect(clean.ast.program.body).toHaveLength(1);
    expect(clean.completeness).toBe("whole");
    expect(clean.mode).toBe("module-capable");
    expect(clean.recoveredErrors).toBe(0);
    expect(clean.truncatedAtLine).toBeUndefined();

    const recovered: Any = parseWithDiagnostics("let a; let a;");
    expect(recovered.warnings).toEqual(["Parse error (recovered): Identifier 'a' has already been declared. (1:11)"]);
    expect(recovered.completeness).toBe("whole");
    expect(recovered.mode).toBe("module-capable");
    expect(recovered.recoveredErrors).toBe(1);

    const truncated: Any = parseWithDiagnostics("var keep = 1;\n@@@");
    expect(truncated.warnings[0]).toMatch(/^Truncated at line 2: /);
    expect(truncated.ast.program.body).toHaveLength(1);
    expect(truncated.completeness).toBe("truncated");
    expect(truncated.truncatedAtLine).toBe(2);

    const emptyAt1: Any = parseWithDiagnostics("@@@");
    expect(emptyAt1.warnings).toContain("Could not parse source; returned empty program");
    expect(emptyAt1.completeness).toBe("empty");
    expect(emptyAt1.truncatedAtLine).toBe(1);

    // primary error at line 3; the prefix itself does not parse, so the empty fallback is reached
    const emptyAt3: Any = parseWithDiagnostics('var s = "ok";\nfunction f() {\n@@@');
    expect(emptyAt3.completeness).toBe("empty");
    expect(emptyAt3.truncatedAtLine).toBe(3);
  });

  it("reports script-fallback parses, clean and with recovered errors, through a stubbed parser facade", async () => {
    for (const injected of [[], [{ message: "stub recovered problem" }]]) {
      vi.resetModules();
      vi.doMock(BABEL_FACADE, async (importOriginal) => {
        const orig: Any = await importOriginal();
        return {
          ...orig,
          parse: (source: string, options: Any) => {
            if (options?.sourceType !== "script") throw syntaxErrorAt(1);
            const ast = orig.parse("stubbed;", { ...options, errorRecovery: true });
            ast.errors = injected;
            return ast;
          },
        };
      });
      const parser: Any = await import(/* @vite-ignore */ PARSER);
      const r = parser.parseWithDiagnostics("anything at all");
      expect(r.warnings).toContain("Fell back to sourceType 'script' after module parse failure");
      expect(r.completeness).toBe("whole");
      expect(r.mode).toBe("script-fallback");
      expect(r.recoveredErrors).toBe(injected.length);
      if (injected.length > 0) expect(r.warnings).toContain("Parse error (recovered): stub recovered problem");
      vi.doUnmock(BABEL_FACADE);
    }
  });

  it("keeps the truncation line when a failing prefix parse falls through to the empty program", async () => {
    const full = "line1();\nline2();\nline3(\nbroken at four";
    vi.doMock(BABEL_FACADE, async (importOriginal) => {
      const orig: Any = await importOriginal();
      return {
        ...orig,
        parse: (source: string, options: Any) => {
          if (source === "") return orig.parse("", options);
          if (source === full) throw syntaxErrorAt(4);
          throw syntaxErrorAt(3); // the prefix parse fails too
        },
      };
    });
    const parser: Any = await import(/* @vite-ignore */ PARSER);
    const r = parser.parseWithDiagnostics(full);
    expect(r.ast.program.body).toHaveLength(0);
    expect(r.completeness).toBe("empty");
    expect(r.truncatedAtLine).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// FC-111 / FC-112 pipeline result fields
// ---------------------------------------------------------------------------

describe("pipeline result carries the initial parse outcome and statement counts (FC-111, FC-112, CS-02, CS-03)", () => {
  it("exposes initialParse, inputStatementCount and finalStatementCount (directives counted)", () => {
    const two: Any = runPipelineWithReport("var a = 1;\nvar b = 2;\n", [], [formatPass]);
    expect(two.initialParse.completeness).toBe("whole");
    expect(two.initialParse.recoveredErrors).toBe(0);
    expect(two.inputStatementCount).toBe(2);
    expect(two.finalStatementCount).toBe(2);

    const directive: Any = runPipelineWithReport("'use strict';", [], []);
    expect(directive.inputStatementCount).toBe(1);

    const trunc: Any = runPipelineWithReport("var keep = 1;\n@@@", [], []);
    expect(trunc.initialParse.completeness).toBe("truncated");
    expect(trunc.initialParse.truncatedAtLine).toBe(2);

    const empty: Any = runPipelineWithReport("@@@", [], []);
    expect(empty.initialParse.completeness).toBe("empty");
    expect(empty.initialParse.truncatedAtLine).toBe(1);
    expect(empty.inputStatementCount).toBe(0);
  });

  it("counts zero final statements when a pass empties the program even if a comment banner survives in the text", () => {
    const emptier = pass("emptier", (ast) => {
      ast.program.body = [];
      ast.program.directives = [];
      (ast.program as Any).innerComments = [{ type: "CommentBlock", value: " banner survives " }];
      return ast;
    });
    const r: Any = runPipelineWithReport("var a = 1;\nconsole.log(a);\n", [emptier], [formatPass]);
    expect(r.code).toContain("banner survives");
    expect(r.inputStatementCount).toBe(2);
    expect(r.finalStatementCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FC-113 transactional pass skip
// ---------------------------------------------------------------------------

describe("transactional skip of a throwing pass (FC-113, CS-04)", () => {
  const COMMENTED = "// lead\nvar a = 1; // trail\n/* mid */\nfunction f() { return 1 + 2; }\n";

  it("an AST pass that mutates (comments included) and then throws leaves no trace: output equals the run without it", () => {
    const mutator = pass("mutator", (ast) => {
      const body = ast.program.body;
      body.reverse();
      body[0].leadingComments = body[body.length - 1].leadingComments;
      body.push(t.expressionStatement(t.identifier("INJECTED_BY_MUTATOR")) as Any);
      ast.comments = [];
      throw new Error("mutate-then-throw");
    });
    let laterRuns = 0;
    const later = pass("later", (ast) => {
      laterRuns++;
      return ast;
    });
    const withPass: Any = runPipelineWithReport(COMMENTED, [mutator, constantFoldPass, later], [formatPass]);
    const without = runPipelineWithReport(COMMENTED, [constantFoldPass, later], [formatPass]);
    expect(withPass.code).toBe(without.code);
    expect(withPass.code).not.toContain("INJECTED_BY_MUTATOR");
    expect(withPass.warnings.length).toBeGreaterThan(0);
    for (const w of withPass.warnings) expect(w).toBe("mutator: mutate-then-throw");
    const mutatorEntries = withPass.report.filter((e: Any) => e.name === "mutator");
    expect(mutatorEntries.length).toBe(withPass.warnings.length);
    for (const e of mutatorEntries) expect(e.changed).toBe(false);
    expect(laterRuns).toBeGreaterThan(0);
  });

  it("restores the AST and the PipelineContext in place: the next pass sees a state deep-equal to the pre-pass state", () => {
    const records: Array<{ label: string; state: unknown; source: string | undefined; context: unknown }> = [];
    const probe = (label: string) =>
      pass(`probe-${label}`, (ast, source, context) => {
        records.push({ label, state: structuredClone({ ast, context }), source, context });
        return ast;
      });
    const thrower = pass("context-thrower", (ast, _source, context) => {
      context!.metadata.injected = { by: "context-thrower" };
      if (context!.fingerprint) (context!.fingerprint as Any).obfuscator = "tampered";
      else (context as Any).fingerprint = { obfuscator: "tampered", confidence: 1, patterns: [] };
      ast.program.body.push(t.expressionStatement(t.identifier("tampered")) as Any);
      ast.program.body[0].start = 9999;
      throw new Error("context failure");
    });
    const r: Any = runPipelineWithReport("var a = 1;\nconsole.log(a);\n", [probe("before"), thrower, probe("after")], []);
    expect(r.warnings).toContain("context-thrower: context failure");
    const before = records.find((x) => x.label === "before")!;
    const after = records.find((x) => x.label === "after")!;
    expect(after).toBeDefined();
    expect(isDeepStrictEqual(after.state, before.state)).toBe(true);
    expect(after.source).toBe(before.source);
    expect(after.context).toBe(before.context); // same context object (in-place restore)
  });

  it("covers a pass that throws before any mutation and a pass that throws only in a later iteration", () => {
    const src = "var a = 1 + 2;\nconsole.log(a);\n";
    const early = pass("early", () => {
      throw new Error("early failure");
    });
    const r1: Any = runPipelineWithReport(src, [early, constantFoldPass], [formatPass]);
    expect(r1.code).toBe(runPipelineWithReport(src, [constantFoldPass], [formatPass]).code);
    expect(r1.warnings).toContain("early: early failure");

    let calls = 0;
    const late = pass("late", (ast) => {
      calls++;
      if (calls >= 2) {
        ast.program.body.push(t.expressionStatement(t.identifier("LATE_INJECTION")) as Any);
        throw new Error("late failure");
      }
      return ast;
    });
    const r2: Any = runPipelineWithReport(src, [constantFoldPass, late], [formatPass]);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(r2.code).toBe(runPipelineWithReport(src, [constantFoldPass], [formatPass]).code);
    expect(r2.code).not.toContain("LATE_INJECTION");
    expect(r2.warnings).toContain("late: late failure");
  });

  it("a throwing token pass, and the format pass forced to throw, leave the text unchanged and later token passes run", () => {
    const src = "var a = 1;\nfunction f() { return a; }\n";
    const thrower: TokenPass = {
      name: "token-thrower",
      description: "test",
      run: () => {
        throw new Error("token failure");
      },
    };
    const seen: string[] = [];
    const recorder: TokenPass = {
      name: "token-recorder",
      description: "test",
      run: (s) => {
        seen.push(s);
        return s;
      },
    };
    const withThrower: Any = runPipelineWithReport(src, [], [thrower, formatPass, recorder]);
    const without = runPipelineWithReport(src, [], [formatPass, recorder]);
    expect(withThrower.code).toBe(without.code);
    expect(withThrower.warnings).toContain("token-thrower: token failure");
    expect(withThrower.report).toContainEqual({ name: "token-thrower", changed: false });
    expect(seen).toHaveLength(2);

    const spy = vi.spyOn(formatPass, "run").mockImplementation(() => {
      throw new Error("format failure");
    });
    try {
      const forced: Any = runPipelineWithReport(src, [], [formatPass]);
      expect(forced.code).toBe(runPipelineWithReport(src, [], []).code);
      expect(forced.warnings).toContain("format: format failure");
      expect(forced.report).toContainEqual({ name: "format", changed: false });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("rollback leaves no trace of re-execution (FC-113, CS-04, OD-CLI-18)", () => {
  it("a clean run executes each pass once per iteration; two failing passes are each skipped once per invocation, no duplicate entries", () => {
    const src = "var a = 1 + 2;\nconsole.log(a);\n";
    const runs: Record<string, number> = {};
    const counted = (p: ASTPass): ASTPass => pass(p.name, (ast, s, ctx) => {
      runs[p.name] = (runs[p.name] ?? 0) + 1;
      return p.run(ast, s, ctx);
    });
    const ident = pass("identity", (ast) => ast);

    const clean: Any = runPipelineWithReport(src, [counted(constantFoldPass), counted(ident)], []);
    expect(clean.warnings).toEqual([]);
    expect(runs["constant-fold"]).toBe(clean.iterations);
    expect(runs["identity"]).toBe(clean.iterations);
    expect(clean.report).toHaveLength(2 * clean.iterations);

    for (const k of Object.keys(runs)) delete runs[k];
    const fail = (name: string) => counted(pass(name, (ast) => {
      ast.program.body = [];
      throw new Error(`${name} failed`);
    }));
    const r: Any = runPipelineWithReport(src, [fail("fail-one"), counted(constantFoldPass), fail("fail-two")], [formatPass]);
    expect(r.code).toBe(runPipelineWithReport(src, [constantFoldPass], [formatPass]).code);
    for (const name of ["fail-one", "fail-two"]) {
      expect(runs[name]).toBe(r.iterations);
      expect(r.warnings.filter((w: string) => w === `${name}: ${name} failed`)).toHaveLength(r.iterations);
      expect(r.report.filter((e: Any) => e.name === name)).toHaveLength(r.iterations);
    }
    expect(runs["constant-fold"]).toBe(r.iterations);
    expect(r.report.filter((e: Any) => e.name === "constant-fold")).toHaveLength(r.iterations);
  });
});

// ---------------------------------------------------------------------------
// FC-114 inter-iteration re-parse discard
// ---------------------------------------------------------------------------

describe("inter-iteration re-parse discard (FC-114, CS-11)", () => {
  const SRC = "var a = 1;\nconsole.log(a);\n";

  function garbler(kind: "truncation" | "recovery" | "empty", atInvocation = 1): ASTPass {
    let n = 0;
    return pass("garbler", (ast) => {
      n++;
      if (n !== atInvocation) return ast;
      if (kind === "truncation") ast.program.body.push(t.expressionStatement(t.identifier("x;\n@@@")) as Any);
      if (kind === "recovery") ast.program.body.push(t.expressionStatement(t.identifier("var await = 1")) as Any);
      if (kind === "empty") ast.program.body = [t.expressionStatement(t.identifier("@@@")) as Any];
      return ast;
    });
  }

  function counter() {
    const state = { runs: 0 };
    return { state, pass: pass("counter", (ast) => {
      state.runs++;
      return ast;
    }) };
  }

  const KEYWORD: Record<string, RegExp> = {
    truncation: /truncat/i,
    recovery: /recover/i,
    empty: /empty/i,
  };
  // the discard warning names the iteration / re-parse; parser warnings never do
  const DISCARD = /iteration|re-?pars/i;

  for (const kind of ["truncation", "recovery", "empty"] as const) {
    it(`a first-iteration re-parse needing ${kind} is discarded: original state, warning, no further iteration`, () => {
      const c = counter();
      const r: Any = runPipelineWithReport(SRC, [garbler(kind), c.pass], [formatPass]);
      expect(r.code).toBe(runPipelineWithReport(SRC, [], [formatPass]).code);
      expect(c.state.runs).toBe(1);
      const discard = r.warnings.filter((w: string) => DISCARD.test(w) && KEYWORD[kind].test(w));
      expect(discard.length).toBe(1);
      expect(r.finalStatementCount).toBe(2);
    });
  }

  it("a later-iteration discard continues from the last state that parsed completely", () => {
    const src = "var a = 1 + 2;\nconsole.log(a);\n";
    const c = counter();
    const r: Any = runPipelineWithReport(src, [constantFoldPass, garbler("truncation", 2), c.pass], [formatPass]);
    expect(r.code).toBe(runPipelineWithReport(src, [constantFoldPass], [formatPass]).code);
    expect(c.state.runs).toBe(2);
    expect(r.warnings.filter((w: string) => DISCARD.test(w) && /truncat/i.test(w))).toHaveLength(1);
  });

  // THAW-1 (OD-CLI-7-ERRATA): degradation is judged relative to the INITIAL parse
  const RECOVERED_INPUT = "foo(1 + 2);\nvar await = 1;\n";

  it("an input whose initial parse already has a recovered error is still transformed (no discard without degradation)", () => {
    const initial: Any = parseWithDiagnostics(RECOVERED_INPUT);
    expect(initial.warnings.filter((w: string) => w.startsWith("Parse error (recovered)"))).toHaveLength(1);
    const r: Any = runPipelineWithReport(RECOVERED_INPUT, [constantFoldPass], [formatPass]);
    expect(r.code).toContain("foo(3)");
    expect(r.code).not.toContain("1 + 2");
    expect(r.warnings.filter((w: string) => DISCARD.test(w))).toEqual([]);
  });

  it("a re-parse with more recovered errors than the initial parse is still discarded with a warning", () => {
    const c = counter();
    const r: Any = runPipelineWithReport(RECOVERED_INPUT, [garbler("recovery"), c.pass], [formatPass]);
    expect(r.code).toBe(runPipelineWithReport(RECOVERED_INPUT, [], [formatPass]).code);
    expect(c.state.runs).toBe(1);
    expect(r.warnings.filter((w: string) => DISCARD.test(w) && /recover/i.test(w))).toHaveLength(1);
  });

  // THAW-2 (F-A10-01): the iteration-end generate, right before the re-parse, throws
  it("a throwing iteration-end generate is a degraded re-parse: discarded, pre-iteration state kept, one warning, token passes run", async () => {
    const src = "var a = 1;\nconsole.log(a);\n";
    const expected = runPipelineWithReport(src, [], [formatPass]).code;
    const arm = { armed: false, afterArm: 0, thrown: 0 };
    vi.resetModules();
    vi.doMock(PARSER, async (importOriginal) => {
      const orig: Any = await importOriginal();
      return {
        ...orig,
        generate: (ast: Any) => {
          if (arm.armed) {
            arm.afterArm++;
            // 1st call after the pass: its change detection; 2nd: the iteration-end generate
            if (arm.afterArm === 2) {
              arm.thrown++;
              throw new Error("iteration-end generate exploded");
            }
          }
          return orig.generate(ast);
        },
      };
    });
    const pipeline: Any = await import(/* @vite-ignore */ PIPELINE);
    const fmt: Any = (await import(/* @vite-ignore */ join(ROOT, "src", "passes", "format.ts"))).formatPass;
    let first = true;
    const mutator = pass("mutator", (ast) => {
      if (first) {
        first = false;
        ast.program.body.push(t.expressionStatement(t.identifier("ADDED_BY_MUTATOR")) as Any);
        arm.armed = true;
      }
      return ast;
    });
    const seen: string[] = [];
    const recorder: TokenPass = { name: "token-recorder", description: "test", run: (s) => (seen.push(s), s) };
    let r: Any;
    expect(() => {
      r = pipeline.runPipelineWithReport(src, [mutator], [fmt, recorder]);
    }).not.toThrow();
    expect(arm.thrown).toBe(1);
    expect(r.code).toBe(expected);
    expect(r.code).not.toContain("ADDED_BY_MUTATOR");
    const discard = r.warnings.filter((w: string) => DISCARD.test(w));
    expect(discard).toHaveLength(1);
    expect(discard[0]).toMatch(/generat/i);
    expect(seen).toHaveLength(1);
  });

  // THAW-3 (F-A10-R1-01): on the FINAL iteration no re-parse follows, so a throwing
  // iteration-end generate is an internal error, not a discard
  it("a throwing iteration-end generate on the final iteration (no re-parse follows) propagates with the collected warnings", async () => {
    const src = "var a = 1;\nconsole.log(a);\n";
    const arm = { armed: false, afterArm: 0, thrown: 0 };
    const boom = new Error("final-iteration generate exploded");
    vi.resetModules();
    vi.doMock(PARSER, async (importOriginal) => {
      const orig: Any = await importOriginal();
      return {
        ...orig,
        generate: (ast: Any) => {
          if (arm.armed) {
            arm.afterArm++;
            if (arm.afterArm === 2) {
              arm.thrown++;
              throw boom;
            }
          }
          return orig.generate(ast);
        },
      };
    });
    const pipeline: Any = await import(/* @vite-ignore */ PIPELINE);
    const skipper = pass("skipper", () => {
      throw new Error("skip me");
    });
    let invocation = 0;
    // changes the program on every invocation, so all three iterations run
    const grower = pass("grower", (ast) => {
      invocation++;
      ast.program.body.push(t.expressionStatement(t.identifier(`GROWN_${invocation}`)) as Any);
      if (invocation === 3) arm.armed = true; // the final iteration (maxIterations = 3)
      return ast;
    });
    let caught: Any;
    try {
      pipeline.runPipelineWithReport(src, [skipper, grower], []);
    } catch (e) {
      caught = e;
    }
    expect(invocation).toBe(3);
    expect(arm.thrown).toBe(1);
    expect(caught).toBe(boom);
    expect(caught.warnings).toContain("skipper: skip me");
  });

  it("a re-parse that throws is discarded with a warning (mocked parseWithDiagnostics)", async () => {
    const src = "var a = 1 + 2;\nconsole.log(a);\n";
    const expected = runPipelineWithReport(src, [], [formatPass]).code;
    vi.doMock(PARSER, async (importOriginal) => {
      const orig: Any = await importOriginal();
      return {
        ...orig,
        // only the re-parse of generated code throws; parsing the original input (initial or restore) works
        parseWithDiagnostics: (source: string) => {
          if (source !== src) throw new Error("re-parse exploded");
          return orig.parseWithDiagnostics(source);
        },
      };
    });
    const pipeline: Any = await import(/* @vite-ignore */ PIPELINE);
    const fold: Any = (await import(/* @vite-ignore */ join(ROOT, "src", "passes", "constant-fold.ts"))).constantFoldPass;
    const fmt: Any = (await import(/* @vite-ignore */ join(ROOT, "src", "passes", "format.ts"))).formatPass;
    const c = counter();
    const r = pipeline.runPipelineWithReport(src, [fold, c.pass], [fmt]);
    expect(r.code).toBe(expected);
    expect(c.state.runs).toBe(1);
    expect(r.warnings.filter((w: string) => DISCARD.test(w) && /throw|threw|exception|error|exploded/i.test(w))).toHaveLength(1);
  });

  it("accepts a script-fallback re-parse with zero recovered errors (no discard)", async () => {
    const src = "var a = 1 + 2;\nconsole.log(a);\n";
    const c0 = counter();
    const reference = runPipelineWithReport(src, [constantFoldPass, c0.pass], [formatPass]);
    vi.doMock(PARSER, async (importOriginal) => {
      const orig: Any = await importOriginal();
      let n = 0;
      return {
        ...orig,
        parseWithDiagnostics: (source: string) => {
          n++;
          const real = orig.parseWithDiagnostics(source);
          return n >= 2 ? { ...real, mode: "script-fallback" } : real;
        },
      };
    });
    const pipeline: Any = await import(/* @vite-ignore */ PIPELINE);
    const fold: Any = (await import(/* @vite-ignore */ join(ROOT, "src", "passes", "constant-fold.ts"))).constantFoldPass;
    const fmt: Any = (await import(/* @vite-ignore */ join(ROOT, "src", "passes", "format.ts"))).formatPass;
    const c = counter();
    const r = pipeline.runPipelineWithReport(src, [fold, c.pass], [fmt]);
    expect(r.code).toBe(reference.code);
    expect(c.state.runs).toBe(c0.state.runs);
    expect(r.warnings).toEqual(reference.warnings);
  });
});

// ---------------------------------------------------------------------------
// FC-120(a) / FC-115 runner catch and unchanged surfaces
// ---------------------------------------------------------------------------

describe("unexpected-error catch in runPipelineWithReport (FC-120, FC-115, CS-13)", () => {
  const skipper = pass("skipper", () => {
    throw new Error("skip me");
  });

  async function pipelineWithThrowingFinalEntropy(thrown: unknown): Promise<Any> {
    vi.doMock(ENTROPY, () => {
      let n = 0;
      return {
        identifierEntropy: () => {
          n++;
          if (n === 2) throw thrown;
          return 0;
        },
      };
    });
    return await import(/* @vite-ignore */ PIPELINE);
  }

  it("rethrows the same Error object after a skipped pass, with the collected warnings recoverable from it", async () => {
    const boom = new Error("entropy exploded");
    const pipeline = await pipelineWithThrowingFinalEntropy(boom);
    let caught: unknown;
    try {
      pipeline.runPipelineWithReport("var a = 1;\n", [skipper], []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    expect((caught as Any).warnings).toContain("skipper: skip me");
  });

  it("carries the warnings for a thrown non-Error value and preserves its string form", async () => {
    const pipeline = await pipelineWithThrowingFinalEntropy("entropy string value");
    let caught: Any;
    try {
      pipeline.runPipelineWithReport("var a = 1;\n", [skipper], []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String(caught) === "entropy string value" || caught?.message === "entropy string value").toBe(true);
    expect(caught?.warnings).toContain("skipper: skip me");
  });

  it("leaves the success-path result identical to base and runPipeline / runASTPipeline still propagate a throwing pass", () => {
    const src = "var a = 1 + 2;\nif (false) { dead(); }\nconsole.log(a);\n";
    const r: Any = runPipelineWithReport(src, [constantFoldPass, deadCodeEliminatePass], [formatPass]);
    // values recorded from base 0a45ecc for this input and these passes
    expect({
      code: r.code,
      warnings: r.warnings,
      report: r.report,
      iterations: r.iterations,
      initialEntropy: r.initialEntropy,
      finalEntropy: r.finalEntropy,
    }).toEqual({
      code: "var a = 3;\nconsole.log(a);\n",
      warnings: [],
      report: [
        { name: "constant-fold", changed: true },
        { name: "dead-code-eliminate", changed: true },
        { name: "constant-fold", changed: false },
        { name: "dead-code-eliminate", changed: false },
        { name: "format", changed: true },
      ],
      iterations: 2,
      initialEntropy: 1.9219280948873623,
      finalEntropy: 1.5,
    });

    const thrower = pass("thrower", () => {
      throw new Error("must propagate");
    });
    expect(() => runPipeline("var a = 1;", [thrower], [])).toThrow("must propagate");
    expect(() => runASTPipeline("var a = 1;", [thrower])).toThrow("must propagate");
  });
});
