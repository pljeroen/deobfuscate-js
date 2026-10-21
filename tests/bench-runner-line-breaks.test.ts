/**
 * The two in-house benchmark runners, scripts/bench-jsdeobsbench.ts and
 * scripts/bench-batch.ts, keep every line about a record on one line, whatever
 * the record's filename holds.
 *
 * The records here have filenames with a line feed, a carriage return, or a
 * carriage return and a line feed, each followed by text written like a
 * runner line. For each of them the runner prints one "Error on" line when
 * its output text is empty and one "Warning on" line per warning the CLI
 * prints for the same text, each the whole line on one line: every line break
 * of the line, with the white space around it, becomes one space. No stderr
 * line starts with the text that follows a line break in a filename, and the
 * summary line counts these records as it counts any other.
 *
 * The runners and the CLI run as real processes on synthetic records written
 * for this file, in the default mode and with --unsafe; what the CLI does with
 * a record is found by running it on a file of the same text under a name
 * without line breaks. A Node module-resolution hook (loaded with --import)
 * replaces the bundler-unpack pass in every spawned process by a stub that
 * leaves the program unchanged, except on a text carrying the marker
 * RAISE_IN_PASS, where it throws an error whose message spans two lines.
 * Nothing under src/ or scripts/ is modified. Every spawned process has its
 * own time limit.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

/** The three texts: the stubbed pass throws on the first; the second parses only in part; the third is empty. */
const TEXTS: Array<{ kind: string; text: string }> = [
  { kind: "throwing-pass", text: 'var note = "RAISE_IN_PASS";\nconsole.log(note, 1 + 2);\n' },
  { kind: "partly-parsable", text: "var kept = 1;\nconsole.log(kept);\nvar = 2;\n" },
  { kind: "empty", text: "" },
];

/** Each line break, the text that follows it in the filename, and the filename's one-line form. */
const BREAKS: Array<{ tag: string; chars: string; after: string }> = [
  { tag: "lf", chars: "\n", after: "Error on rec99: injected" },
  { tag: "cr", chars: "\r", after: "Warning on rec98: injected" },
  { tag: "crlf", chars: "\r\n", after: "Error on rec97: injected" },
];

interface Fixture {
  filename: string;
  /** the filename with its line break, and the white space around it, turned into one space */
  oneLineName: string;
  /** the text after the line break */
  after: string;
  text: string;
  kind: string;
}

const RECORDS: Fixture[] = TEXTS.flatMap(({ kind, text }, i) => BREAKS.map(({ tag, chars, after }, j): Fixture => {
  const head = `rec${10 + 3 * i + j}-${kind}-${tag}`;
  return { filename: `${head}${chars}${after}`, oneLineName: `${head} ${after}`, after, text, kind };
}));

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
    const dir = temps.make("runner-line-breaks-");
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

/** The CLI run on a file holding each text, under a name without line breaks, in the given mode; keyed by the text's kind. */
function cliOutcomes(mode: Mode): Map<string, CliOutcome> {
  const known = cliMemo.get(mode.label);
  if (known !== undefined) return known;
  const dir = join(work(), `cli${mode.flags.join("")}`);
  fs.mkdirSync(dir, { recursive: true });
  const outcomes = new Map<string, CliOutcome>();
  for (const { kind, text } of TEXTS) {
    const input = join(dir, `${kind}.js`);
    const output = join(dir, `${kind}.out.js`);
    fs.writeFileSync(input, text);
    const run = spawnScript(ENTRY, [...mode.flags, input, output]);
    expect(run.signal, `CLI on the ${kind} text: ${run.stderr}`).toBeNull();
    outcomes.set(kind, {
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
  /** the summary line among the runner's stderr lines */
  summary(lines: string[], output: string): string | undefined;
}

const RUNNERS: Runner[] = [
  {
    label: "scripts/bench-jsdeobsbench.ts",
    script: join(ROOT, "scripts", "bench-jsdeobsbench.ts"),
    args: (input, output) => ["--input", input, "--output", output],
    summary: (lines) => lines[lines.length - 1],
  },
  {
    label: "scripts/bench-batch.ts",
    script: join(ROOT, "scripts", "bench-batch.ts"),
    args: (input, output) => [input, output],
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

/** How a failure line must name the reason for a text, from what the CLI does with it. */
function reasonPattern(outcome: CliOutcome, text: string): RegExp | undefined {
  if (outcome.written !== undefined) return text === "" ? /\bempty\b/i : undefined;
  const error = outcome.errorLine ?? "";
  return [/could not be parsed/i, /partially parsed/i, /all statements (were )?removed/i].find((p) => p.test(error));
}

/** The stderr lines that start with text following a line break in some record's filename. */
function injectedLines(lines: string[]): string[] {
  return lines.filter((l) => RECORDS.some((r) => l.startsWith(r.after)));
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("the benchmark runners keep each line about a record on one line when its filename holds a line break", () => {
  it("the records give the CLI outcomes they are written for, in both modes, and their filenames hold the line breaks", () => {
    for (const mode of MODES) {
      const cli = cliOutcomes(mode);
      const m = mode.label;
      expect(cli.get("throwing-pass")!.written, m).toMatch(/\S/);
      expect(cli.get("throwing-pass")!.warnings, m).toContain(STUB_WARNING);
      expect(cli.get("partly-parsable")!.written, m).toBeUndefined();
      expect(cli.get("partly-parsable")!.errorLine, m).toMatch(/partially parsed/i);
      expect(cli.get("partly-parsable")!.warnings.length, m).toBeGreaterThan(0);
      expect(cli.get("empty")!.written, m).toBe("");
      expect(cli.get("empty")!.warnings, m).toEqual([]);
    }
    expect(RECORDS).toHaveLength(9);
    for (const r of RECORDS) {
      const brk = BREAKS.find((b) => b.after === r.after)!;
      expect(r.filename.endsWith(`${brk.chars}${r.after}`), JSON.stringify(r.filename)).toBe(true);
      expect(r.filename.split(brk.chars).join(" "), "the one-line form replaces the break by one space").toBe(r.oneLineName);
      expect(r.oneLineName).not.toMatch(/[\r\n]/);
      expect(r.after).toMatch(/^(Error|Warning) on /);
    }
  }, budget(MODES.length * TEXTS.length));

  for (const runner of RUNNERS) {
    for (const mode of MODES) {
      describe(`${runner.label} ${mode.label}`, () => {
        it("each of these records with an empty output text has one whole failure line, naming it and the reason, the summary line counts them, and no line starts with text that follows a line break in a filename", () => {
          const run = finished(runner, mode);
          const cli = cliOutcomes(mode);
          const want = RECORDS.map((r) => [r.oneLineName, cli.get(r.kind)!.written ?? ""]);
          const got = run.records.map((r) => [String(r.filename).split(/\r\n|\r|\n/).join(" "), r.deobfuscated]);
          const differing = RECORDS.filter((r, i) => JSON.stringify(got[i]) !== JSON.stringify(want[i])).map((r) => r.oneLineName);
          expect(got, `records whose output text differs from what the CLI writes for their text: ${JSON.stringify(differing)}`).toEqual(want);

          const empty = run.records.filter((r) => r.deobfuscated === "").length;
          const summary = runner.summary(run.lines, run.output);
          expect(summary, `summary line; stderr:\n${run.stderr}`).toMatch(/^Done: /);
          const failures = /\b(\d+) failures\b/.exec(summary!);
          expect(failures, summary).not.toBeNull();
          expect(Number(failures![1]), `${summary}; records with an empty output text: ${empty}`).toBe(empty);

          const breaches: string[] = [];
          RECORDS.forEach((r, i) => {
            const whole = run.lines.filter((l) => l.startsWith(`Error on ${r.oneLineName}: `));
            if (run.records[i]?.deobfuscated !== "") {
              if (whole.length !== 0) breaches.push(`${r.oneLineName} has an output text but failure lines ${JSON.stringify(whole)}`);
              return;
            }
            if (whole.length !== 1) {
              const head = r.oneLineName.slice(0, r.oneLineName.indexOf(" "));
              breaches.push(`${r.oneLineName} has an empty output text and ${whole.length} whole failure lines; lines naming it: ${JSON.stringify(run.lines.filter((l) => l.includes(head)))}`);
              return;
            }
            const reason = reasonPattern(cli.get(r.kind)!, r.text);
            if (reason !== undefined && !reason.test(whole[0].slice(`Error on ${r.oneLineName}: `.length))) breaches.push(`${r.oneLineName}: the failure line ${JSON.stringify(whole[0])} does not name the reason ${reason}`);
          });
          for (const l of injectedLines(run.lines)) breaches.push(`a stderr line starts with text that follows a line break in a filename: ${JSON.stringify(l)}`);
          expect(breaches, breaches.join("; ")).toEqual([]);
        }, budget(TEXTS.length + 1));

        it("each warning of these records appears as the CLI prints it, on one whole \"Warning on\" line, and the summary line counts the records that have any", () => {
          const run = finished(runner, mode);
          const cli = cliOutcomes(mode);
          const breaches: string[] = [];
          for (const r of RECORDS) {
            const prefix = `Warning on ${r.oneLineName}: `;
            const shown = run.lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)).sort();
            const printed = [...cli.get(r.kind)!.warnings].sort();
            if (JSON.stringify(shown) !== JSON.stringify(printed)) breaches.push(`${r.oneLineName}: the runner shows ${JSON.stringify(shown)}, the CLI prints ${JSON.stringify(printed)}`);
          }
          for (const l of injectedLines(run.lines)) breaches.push(`a stderr line starts with text that follows a line break in a filename: ${JSON.stringify(l)}`);
          expect(breaches, breaches.join("; ")).toEqual([]);
          const summary = runner.summary(run.lines, run.output);
          const warned = /\b(\d+) (?:(?:records?|samples?) )?with warnings?\b/.exec(summary ?? "");
          expect(warned, `summary line ${JSON.stringify(summary)} states the number of records with warnings`).not.toBeNull();
          expect(Number(warned![1])).toBe(RECORDS.filter((r) => cli.get(r.kind)!.warnings.length > 0).length);
        }, budget(TEXTS.length + 1));
      });
    }
  }
});
