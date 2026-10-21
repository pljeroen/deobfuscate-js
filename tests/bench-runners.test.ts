/**
 * The two in-house benchmark runners, scripts/bench-jsdeobsbench.ts and
 * scripts/bench-batch.ts, give every record the text the CLI writes for a file
 * holding the record's text in the same mode, or an empty text where the CLI
 * writes nothing; they count exactly those empty records as failures, with
 * one line each that names the record and the reason; and they show each
 * record's warnings as the CLI prints them, with the number of records that
 * have any in their summary line.
 *
 * The runners and the CLI run as real processes on synthetic records written
 * for this file, in the default mode and with --unsafe; what the CLI does with
 * a record is found by running it on the record's text. A Node
 * module-resolution hook (loaded with --import) replaces the bundler-unpack
 * pass in every spawned process by a stub that leaves the program unchanged,
 * except on the record carrying the marker RAISE_IN_PASS, where it throws an
 * error whose message spans two lines. Nothing under src/ or scripts/ is
 * modified. Every spawned process has its own time limit.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, generate } from "../src/parser.js";
import { fingerprint } from "../src/fingerprint.js";
import { controlFlowObjectPass } from "../src/passes/control-flow-object.js";
import { TempDirs } from "./temp-dirs.js";
import { ROOT, ENTRY, SPAWN_TIMEOUT } from "./program-checks.js";

const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const UNSAFE_NOTICE = "WARNING: Unsafe mode enabled — string-array pass will execute untrusted code";

/** Time limit of a test that may start `spawns` processes, each bounded by SPAWN_TIMEOUT. */
function budget(spawns: number): number {
  return spawns * SPAWN_TIMEOUT + 10000;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

interface Fixture {
  filename: string;
  text: string;
}

const RECORDS: Fixture[] = [
  { filename: "rec01-plain", text: "console.log(1 + 2);\n" },
  { filename: "rec02-dead-code-only", text: "if (false) { x(); }\n" },
  { filename: "rec03-unparsable", text: "this is not javascript {{{{\n" },
  { filename: "rec04-partly-parsable", text: "var kept = 1;\nconsole.log(kept);\nvar = 2;\n" },
  { filename: "rec05-empty", text: "" },
  // no obfuscator fingerprint, but the control-flow-object pass would inline the proxy if it ran
  { filename: "rec06-no-obfuscator", text: "var ops = { pLuSx: function (a, b) { return a + b; } };\nconsole.log(ops.pLuSx(4, 5));\n" },
  // the stubbed bundler-unpack pass throws on this record in every iteration
  { filename: "rec07-throwing-pass", text: 'var note = "RAISE_IN_PASS";\nconsole.log(note, 1 + 2);\n' },
  // a flattened dispatcher whose result needs the constant-fold run that follows control-flow-unflatten
  {
    filename: "rec08-flattened",
    text: `function label(_0x1a2b) {
  var _0x2b3c = { order: '2|0|1', name: 'sum', join: function (_0x3c4d, _0x4d5e) { return _0x3c4d + _0x4d5e; } };
  var _0x5e6f = _0x2b3c, _0x6f70 = _0x5e6f.order.split('|'), _0x7081 = 0;
  while (!![]) {
    switch (_0x6f70[_0x7081++]) {
      case '0': var _0x8192 = _0x5e6f.join(_0x5e6f.join(_0x92a3, ':'), _0x1a2b); continue;
      case '1': return _0x8192;
      case '2': var _0x92a3 = _0x5e6f.name; continue;
    }
    break;
  }
}
console.log(label(6));
`,
  },

];

const byName = (filename: string): Fixture => RECORDS.find((r) => r.filename === filename)!;

function inputRecord(r: Fixture): Record<string, unknown> {
  return { filename: r.filename, original: r.text, obfuscated: r.text, test_cases: [], language: "JavaScript" };
}

// ---------------------------------------------------------------------------
// processes
// ---------------------------------------------------------------------------

const STUB_SOURCES: Record<string, string> = {
  "hooks.mjs": `
let map = {};
export async function initialize(data) { map = (data && data.map) || {}; }
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  for (const [suffix, url] of Object.entries(map)) {
    if (r.url.endsWith(suffix)) return { url, format: "module", shortCircuit: true };
  }
  return r;
}
`,
  "preload.mjs": `
import { register } from "node:module";
const map = JSON.parse(process.env.DEOBF_TEST_STUBS || "{}");
register(new URL("./hooks.mjs", import.meta.url), { data: { map } });
`,
  "stub-bundler-unpack.mjs": `
export const bundlerUnpackPass = {
  name: "bundler-unpack",
  description: "test stub",
  run(ast, source) {
    if (typeof source === "string" && source.includes("RAISE_IN_PASS")) throw new Error("stub pass failure\\n  on a second line");
    return ast;
  },
};
`,
};

/** The stub's error message as the CLI prints it: on one line. */
const STUB_WARNING = "bundler-unpack: stub pass failure on a second line";

const temps = new TempDirs();
afterAll(() => temps.removeAll());

let workDir: string | undefined;
function work(): string {
  if (workDir === undefined) {
    const dir = temps.make("bench-runners-");
    for (const [name, text] of Object.entries(STUB_SOURCES)) fs.writeFileSync(join(dir, name), text);
    fs.writeFileSync(join(dir, "records.jsonl"), RECORDS.map((r) => JSON.stringify(inputRecord(r))).join("\n") + "\n");
    workDir = dir;
  }
  return workDir;
}

interface Spawned {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** stderr split at "\n" and "\r", empty pieces dropped */
  lines: string[];
}

function splitLines(text: string): string[] {
  return text.split(/\r|\n/).filter((l) => l !== "");
}

function spawnScript(script: string, args: string[]): Spawned {
  const dir = work();
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, "--import", pathToFileURL(join(dir, "preload.mjs")).href, script, ...args], {
    cwd: ROOT,
    env: { ...process.env, DEOBF_TEST_STUBS: JSON.stringify({ "/src/passes/bundler-unpack.ts": pathToFileURL(join(dir, "stub-bundler-unpack.mjs")).href }) },
    timeout: SPAWN_TIMEOUT,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const stderr = ((r.stderr as Buffer | null) ?? Buffer.alloc(0)).toString("utf-8");
  return { status: r.status, signal: r.signal, stderr, lines: splitLines(stderr) };
}

type Mode = { label: string; flags: string[] };
const MODES: Mode[] = [
  { label: "in the default mode", flags: [] },
  { label: "with --unsafe", flags: ["--unsafe"] },
];

interface CliOutcome {
  /** the bytes written to the output file, as UTF-8; undefined when the CLI wrote no output */
  written: string | undefined;
  /** the ERROR line, when there is one */
  errorLine: string | undefined;
  /** the texts after "WARNING: " of the pipeline warning lines (the --unsafe notice excluded) */
  warnings: string[];
}

const cliMemo = new Map<string, Map<string, CliOutcome>>();

/** The CLI run on a file holding each record's text, in the given mode. */
function cliOutcomes(mode: Mode): Map<string, CliOutcome> {
  const known = cliMemo.get(mode.label);
  if (known !== undefined) return known;
  const dir = join(work(), `cli${mode.flags.join("")}`);
  fs.mkdirSync(dir, { recursive: true });
  const outcomes = new Map<string, CliOutcome>();
  for (const r of RECORDS) {
    const input = join(dir, `${r.filename}.js`);
    const output = join(dir, `${r.filename}.out.js`);
    fs.writeFileSync(input, r.text);
    const run = spawnScript(ENTRY, [...mode.flags, input, output]);
    expect(run.signal, `CLI on ${r.filename}: ${run.stderr}`).toBeNull();
    outcomes.set(r.filename, {
      written: fs.existsSync(output) ? fs.readFileSync(output, "utf-8") : undefined,
      errorLine: run.lines.find((l) => l.startsWith("ERROR: ")),
      warnings: run.lines.filter((l) => l.startsWith("WARNING: ") && l !== UNSAFE_NOTICE).map((l) => l.slice("WARNING: ".length)),
    });
  }
  cliMemo.set(mode.label, outcomes);
  return outcomes;
}

interface Runner {
  label: string;
  script: string;
  args(input: string, output: string): string[];
  /** fields the runner adds to the record at index i, besides deobfuscated */
  added(i: number): Record<string, unknown>;
  /** the summary line among the runner's stderr lines */
  summary(lines: string[], output: string): string | undefined;
}

const RUNNERS: Runner[] = [
  {
    label: "scripts/bench-jsdeobsbench.ts",
    script: join(ROOT, "scripts", "bench-jsdeobsbench.ts"),
    args: (input, output) => ["--input", input, "--output", output],
    added: () => ({}),
    summary: (lines) => lines[lines.length - 1],
  },
  {
    label: "scripts/bench-batch.ts",
    script: join(ROOT, "scripts", "bench-batch.ts"),
    args: (input, output) => [input, output],
    added: (i) => ({ task_type: "deobfuscation", task_id: i }),
    summary: (lines, output) => {
      const written = lines.indexOf(`Written: ${output}`);
      return written > 0 ? lines[written - 1] : undefined;
    },
  },
];

interface RunnerRun extends Spawned {
  output: string;
  records: Array<Record<string, unknown>> | undefined;
}

const runnerMemo = new Map<string, RunnerRun>();

function runRunner(runner: Runner, mode: Mode): RunnerRun {
  const key = `${runner.label} ${mode.label}`;
  const known = runnerMemo.get(key);
  if (known !== undefined) return known;
  const dir = work();
  const output = join(dir, `out-${runner.label.replace(/\W+/g, "-")}${mode.flags.join("")}.jsonl`);
  const run = spawnScript(runner.script, [...runner.args(join(dir, "records.jsonl"), output), ...mode.flags]);
  const records = fs.existsSync(output)
    ? fs.readFileSync(output, "utf-8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>)
    : undefined;
  const result = { ...run, output, records };
  runnerMemo.set(key, result);
  return result;
}

/** A finished runner run with its output records; fails the test when the runner did not finish. */
function finished(runner: Runner, mode: Mode): RunnerRun & { records: Array<Record<string, unknown>> } {
  const run = runRunner(runner, mode);
  expect(run.signal, run.stderr).toBeNull();
  expect(run.status, run.stderr).toBe(0);
  expect(run.records, `${runner.label} wrote no output file; stderr:\n${run.stderr}`).toBeDefined();
  return run as RunnerRun & { records: Array<Record<string, unknown>> };
}

/** How a failure line must name the reason for a record, from what the CLI does with its text. */
function reasonPattern(outcome: CliOutcome, text: string): RegExp | undefined {
  if (outcome.written !== undefined) return text === "" ? /\bempty\b/i : undefined;
  const error = outcome.errorLine ?? "";
  return [/could not be parsed/i, /partially parsed/i, /all statements (were )?removed/i].find((p) => p.test(error));
}

function warningLines(lines: string[], filename: string): string[] {
  const prefix = `Warning on ${filename}: `;
  return lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("the benchmark runners write, count and report what the CLI does", () => {
  it("the records give the CLI outcomes they are written for, in both modes", () => {
    for (const mode of MODES) {
      const cli = cliOutcomes(mode);
      const o = (filename: string): CliOutcome => cli.get(filename)!;
      const m = mode.label;
      expect(o("rec01-plain").written, m).toMatch(/\S/);
      expect(o("rec01-plain").warnings, m).toEqual([]);
      expect(o("rec02-dead-code-only").written, m).toBeUndefined();
      expect(o("rec02-dead-code-only").errorLine, m).toMatch(/all statements (were )?removed/i);
      expect(o("rec03-unparsable").written, m).toBeUndefined();
      expect(o("rec03-unparsable").errorLine, m).toMatch(/could not be parsed/i);
      expect(o("rec04-partly-parsable").written, m).toBeUndefined();
      expect(o("rec04-partly-parsable").errorLine, m).toMatch(/partially parsed/i);
      expect(o("rec05-empty").written, m).toBe("");
      expect(o("rec06-no-obfuscator").written, m).toContain("ops.pLuSx(4, 5)");
      expect(o("rec07-throwing-pass").written, m).toMatch(/\S/);
      expect(o("rec07-throwing-pass").warnings, m).toContain(STUB_WARNING);
      for (const name of ["rec08-flattened"]) expect(o(name).written, `${name} ${m}`).toMatch(/\S/);
    }
    const noObfuscator = byName("rec06-no-obfuscator").text;
    expect(fingerprint(parse(noObfuscator)).obfuscator).toBeNull();
    expect(generate(controlFlowObjectPass.run(parse(noObfuscator))), "the control-flow-object pass changes it when it runs").not.toBe(generate(parse(noObfuscator)));
    for (const name of ["rec08-flattened"]) expect(fingerprint(parse(byName(name).text)).obfuscator, name).not.toBeNull();
  }, budget(MODES.length * RECORDS.length));

  for (const runner of RUNNERS) {
    for (const mode of MODES) {
      describe(`${runner.label} ${mode.label}`, () => {
        it("each output record is its input record, in order and with its other fields, plus the text the CLI writes for it, or an empty text where the CLI writes nothing", () => {
          const run = finished(runner, mode);
          const cli = cliOutcomes(mode);
          const want = RECORDS.map((r) => [r.filename, cli.get(r.filename)!.written ?? ""]);
          const got = run.records.map((r) => [r.filename, r.deobfuscated]);
          const differing = RECORDS.filter((r, i) => JSON.stringify(got[i]) !== JSON.stringify(want[i])).map((r) => r.filename);
          expect(got, `records whose output text differs from what the CLI writes: ${JSON.stringify(differing)}`).toEqual(want);
          expect(run.records).toEqual(RECORDS.map((r, i) => ({ ...inputRecord(r), ...runner.added(i), deobfuscated: cli.get(r.filename)!.written ?? "" })));
        }, budget(RECORDS.length + 1));

        it("the summary line counts as failures exactly the records whose output text is empty", () => {
          const run = finished(runner, mode);
          const summary = runner.summary(run.lines, run.output);
          expect(summary, `summary line; stderr:\n${run.stderr}`).toMatch(/^Done: /);
          const failures = /\b(\d+) failures\b/.exec(summary!);
          expect(failures, summary).not.toBeNull();
          const empty = run.records.filter((r) => r.deobfuscated === "").map((r) => r.filename);
          expect(Number(failures![1]), `${summary}; records with an empty output text: ${JSON.stringify(empty)}`).toBe(empty.length);
        }, budget(1));

        it("each record with an empty output text has exactly one failure line, naming the record and the reason, and no other record has one", () => {
          const run = finished(runner, mode);
          const cli = cliOutcomes(mode);
          const breaches: string[] = [];
          RECORDS.forEach((r, i) => {
            const named = run.lines.filter((l) => l.includes(r.filename) && !l.startsWith("Warning on "));
            if (run.records[i]?.deobfuscated !== "") {
              if (named.length !== 0) breaches.push(`${r.filename} has an output text but failure lines ${JSON.stringify(named)}`);
              return;
            }
            if (named.length !== 1) {
              breaches.push(`${r.filename} has an empty output text and ${named.length} failure lines ${JSON.stringify(named)}`);
              return;
            }
            const reason = reasonPattern(cli.get(r.filename)!, r.text);
            if (reason !== undefined && !reason.test(named[0])) breaches.push(`${r.filename}: the failure line ${JSON.stringify(named[0])} does not name the reason ${reason}`);
          });
          expect(breaches, breaches.join("; ")).toEqual([]);
        }, budget(RECORDS.length + 1));

        it("each record's warnings appear as the CLI prints them, one \"Warning on\" line each, and the summary line counts the records that have any", () => {
          const run = finished(runner, mode);
          const cli = cliOutcomes(mode);
          const breaches: string[] = [];
          for (const r of RECORDS) {
            const shown = warningLines(run.lines, r.filename).sort();
            const printed = [...cli.get(r.filename)!.warnings].sort();
            if (JSON.stringify(shown) !== JSON.stringify(printed)) breaches.push(`${r.filename}: the runner shows ${JSON.stringify(shown)}, the CLI prints ${JSON.stringify(printed)}`);
          }
          expect(breaches, breaches.join("; ")).toEqual([]);
          const summary = runner.summary(run.lines, run.output);
          const warned = /\b(\d+) (?:(?:records?|samples?) )?with warnings?\b/.exec(summary ?? "");
          expect(warned, `summary line ${JSON.stringify(summary)} states the number of records with warnings`).not.toBeNull();
          expect(Number(warned![1])).toBe(RECORDS.filter((r) => warningLines(run.lines, r.filename).length > 0).length);
        }, budget(RECORDS.length + 1));
      });
    }
  }
});
