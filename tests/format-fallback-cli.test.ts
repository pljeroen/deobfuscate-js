/**
 * The format pass's fallback and its line-comment fix through the command
 * line tool and the benchmark wrapper (FORMAT-01 R-FM-11 UX-FM-02, R-FM-02
 * AC-02.3, R-FM-03 AC-03.2, R-FM-04 AC-04.3, R-FM-10 AC-10.2), exercised as
 * subprocesses of the real entry points src/index.ts and
 * scripts/deobfuscate-js.sh in both modes.
 *
 * On a fallback the tool exits 0, writes the AST-phase code byte for byte,
 * prints exactly one "WARNING: format: output left unformatted: <reason>"
 * line as the last pipeline warning (after the --unsafe notice and every
 * other pipeline warning, before the --verbose report) and its usual Done
 * line. The AST-phase code is the in-process pipeline result with no token
 * pass, for the tool's shared pass list (src/cli-shared.ts).
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { filterSafePasses, runPipelineWithReport } from "../src/pipeline.js";
import { allASTPasses } from "../src/cli-shared.js";
import type { ASTPass } from "../src/types.js";
const PASS_LISTS: ReadonlyArray<readonly ["default" | "--unsafe", ASTPass[]]> = [
  ["default", filterSafePasses(allASTPasses)],
  ["--unsafe", allASTPasses],
];
import { CLI_FALLBACK_PREFIX, REASON_NOT_PROGRAM, RECOVERED_ERROR_INPUTS, runInVm, shapeCase } from "./format-same-reference.js";
import { TempDirs } from "./temp-dirs.js";

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = join(ROOT, "src", "index.ts");
const WRAPPER = join(ROOT, "scripts", "deobfuscate-js.sh");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const UNSAFE_NOTICE = "WARNING: Unsafe mode enabled — string-array pass will execute untrusted code";
const SPAWN_TIMEOUT = 60000;
const TEST_TIMEOUT = 120000;

const temps = new TempDirs();
afterAll(() => temps.removeAll());

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdoutLines: string[];
  stderrLines: string[];
  output: Buffer | undefined;
}

function lines(text: string): string[] {
  const l = text.split("\n");
  if (l.length > 0 && l[l.length - 1] === "") l.pop();
  return l;
}

/** Writes `source` to a fresh input file and runs `command` on it; returns the streams and the output bytes. */
function runOn(source: string, command: (input: string, output: string) => [string, string[]]): Run {
  const dir = temps.make("format01-cli-");
  const input = join(dir, "in.js");
  const output = join(dir, "out.js");
  fs.writeFileSync(input, source);
  const [cmd, args] = command(input, output);
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env }, timeout: SPAWN_TIMEOUT, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status,
    signal: r.signal,
    stdoutLines: lines(((r.stdout as Buffer | null) ?? Buffer.alloc(0)).toString("utf-8")),
    stderrLines: lines(((r.stderr as Buffer | null) ?? Buffer.alloc(0)).toString("utf-8")),
    output: fs.existsSync(output) ? fs.readFileSync(output) : undefined,
  };
}

function cli(flags: string[]): (input: string, output: string) => [string, string[]] {
  return (input, output) => [process.execPath, ["--import", TSX_LOADER, ENTRY, ...flags, input, output]];
}

function modeFlags(mode: "default" | "--unsafe"): string[] {
  return mode === "--unsafe" ? ["--unsafe"] : [];
}

function astPhase(source: string, passes: ASTPass[]): { code: string; warnings: string[] } {
  const r = runPipelineWithReport(source, passes, []);
  return { code: r.code, warnings: r.warnings };
}

function formatLines(r: Run): string[] {
  return r.stderrLines.filter((l) => l.startsWith("WARNING: format: "));
}

const FALLBACK_LINE = CLI_FALLBACK_PREFIX + REASON_NOT_PROGRAM;

describe("command line tool, text that is not a program (UX-FM-02, AC-02.3, AC-10.2)", () => {
  const cases = RECOVERED_ERROR_INPUTS.flatMap((src, i) => PASS_LISTS.map(([mode, passes]) => [`trigger ${i + 1}`, mode, src, passes] as const));

  it.each(cases)("%s, %s mode: exit 0, the AST-phase code written, the warnings in order with the format line last, Done", (_id, mode, src, passes) => {
    const expected = astPhase(src, passes);
    expect(expected.warnings[0]).toMatch(/^Parse error \(recovered\): /);

    const r = runOn(src, cli(modeFlags(mode)));
    expect(r.signal).toBeNull();
    expect(r.status, r.stderrLines.join("\n")).toBe(0);
    expect(r.stderrLines).toEqual([...(mode === "--unsafe" ? [UNSAFE_NOTICE] : []), ...expected.warnings.map((w) => `WARNING: ${w}`), FALLBACK_LINE]);
    expect(r.output?.toString("utf-8")).toBe(expected.code);
    expect(r.output?.equals(Buffer.from(expected.code, "utf-8"))).toBe(true);
    expect(r.stdoutLines.filter((l) => l.startsWith("Done: "))).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("with --verbose: the report follows the warnings and ends with '  format: no change'", () => {
    const src = RECOVERED_ERROR_INPUTS[0];
    const r = runOn(src, cli(["--verbose"]));
    expect(r.status, r.stderrLines.join("\n")).toBe(0);
    const warningAt = r.stderrLines.indexOf(FALLBACK_LINE);
    const reportAt = r.stderrLines.indexOf("Pass report:");
    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(reportAt).toBeGreaterThan(warningAt);
    expect(r.stderrLines.slice(0, reportAt).filter((l) => l.startsWith("WARNING: ")).pop()).toBe(FALLBACK_LINE);
    expect(r.stderrLines[r.stderrLines.length - 1]).toBe("  format: no change");
    expect(r.output?.toString("utf-8")).toBe(astPhase(src, PASS_LISTS[0][1]).code);
  }, TEST_TIMEOUT);
});

describe("command line tool, shapes the pass now formats (AC-03.2, AC-04.3, UX-FM-02)", () => {
  it.each(PASS_LISTS.map(([mode]) => mode))("trailing line comment, %s mode: exit 0, no format warning, the output runs to [1,2]", (mode) => {
    const r = runOn("out.push(1); // tail\nout.push(2);\n", cli(modeFlags(mode)));
    expect(r.status, r.stderrLines.join("\n")).toBe(0);
    expect(formatLines(r)).toEqual([]);
    expect(runInVm(r.output?.toString("utf-8") ?? "")).toBe("[1,2]");
  }, TEST_TIMEOUT);

  it.each(PASS_LISTS.map(([mode]) => mode))("regex after an if head, %s mode: exit 0, no format warning, the output runs to [\"x\"]", (mode) => {
    const r = runOn(shapeCase("S3").src, cli(modeFlags(mode)));
    expect(r.status, r.stderrLines.join("\n")).toBe(0);
    expect(formatLines(r)).toEqual([]);
    expect(runInVm(r.output?.toString("utf-8") ?? "")).toBe('["x"]');
  }, TEST_TIMEOUT);
});

describe("benchmark wrapper (UX-FM-02)", () => {
  it("text that is not a program: exit 0, the --unsafe AST-phase code written", () => {
    const src = RECOVERED_ERROR_INPUTS[0];
    const r = runOn(src, (input, output) => ["bash", [WRAPPER, input, output]]);
    expect(r.status).toBe(0);
    expect(r.output?.toString("utf-8")).toBe(astPhase(src, allASTPasses).code);
  }, TEST_TIMEOUT);
});
