/**
 * CLI safety: refusals, write-last, reporting shape and the Done stream,
 * exercised through the real entry point src/index.ts as a subprocess.
 *
 * Fault injection uses a Node module-resolution hook (loaded with --import)
 * that substitutes a few internal modules of the spawned process with small
 * synthetic stubs written to a private temp directory: a throwing
 * bundler-unpack pass, an emptying hex-decode pass, a throwing format pass
 * and an entropy function that throws on its second call (a non-pass error
 * inside runPipelineWithReport, after the passes). Nothing under src/ is
 * modified.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TempDirs } from "./temp-dirs.js";

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = join(ROOT, "src", "index.ts");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const MAX = 20 * 1024 * 1024;
const UNSAFE_NOTICE = "WARNING: Unsafe mode enabled — string-array pass will execute untrusted code";
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const SPAWN_TIMEOUT = 60000;

const D = {
  SAME: /^ERROR:.*\bsame file\b/im,
  IDUNK: /^ERROR:.*\b(cannot|could not) (verify|establish)\b/im,
  INPUT: /^ERROR:.*(not found|no such file|permission denied|is a directory|cannot read)/im,
  SIZE: /^ERROR:.*exceeds max size/im,
  PARSE_EMPTY: /^ERROR:.*\bcould not be parsed\b/im,
  PARSE_TRUNC: /^ERROR:.*\bpartially parsed\b.*\bline \d+/im,
  EMPTY: /^ERROR:.*\ball statements (were )?removed\b/im,
  WRITE: /^ERROR:.*\b(write|writing|open)\b.*\bfailed\b/im,
  INTERNAL: /^ERROR: internal error: /m,
} as const;
type Reason = keyof typeof D;
const collected: Partial<Record<Reason, string>> = {};

const RECOVERABLE = "var await = 1;\nconsole.log(1);\n";
const PLAIN = "var a = 1 + 2;\nconsole.log(a);\n";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let STUB_DIR = "";
const temps = new TempDirs();
const writers: ChildProcess[] = [];

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
  "stub-bundler-throw.mjs": `
export const bundlerUnpackPass = {
  name: "bundler-unpack",
  description: "test stub",
  run(ast) {
    ast.program.body.push({ type: "ExpressionStatement", expression: { type: "Identifier", name: "INJECTED_BY_THROWING_STUB" } });
    throw new Error("stub pass failure");
  },
};
`,
  "stub-hex-empty.mjs": `
export const hexDecodePass = {
  name: "hex-decode",
  description: "test stub",
  run(ast) {
    ast.program.body = [];
    ast.program.directives = [];
    ast.program.innerComments = [{ type: "CommentBlock", value: " banner survives " }];
    return ast;
  },
};
`,
  "stub-format-throw.mjs": `
export const formatPass = {
  name: "format",
  description: "test stub",
  run() { throw new Error("stub format failure"); },
};
`,
  "stub-entropy-throw.mjs": `
let calls = 0;
export function identifierEntropy() {
  calls++;
  if (calls === 2) {
    const kind = process.env.DEOBF_TEST_THROW;
    if (kind === "string") throw "internal stub thrown string";
    if (kind === "code") { const e = new Error("internal stub io trouble"); e.code = "EIO"; throw e; }
    throw new Error("internal stub failure\\nsecond line\\nthird line");
  }
  return 0;
}
`,
};

type Stubs = { bundler?: "throw"; hex?: "empty"; format?: "throw"; entropy?: "multiline" | "code" | "string" };

function stubMap(s: Stubs): Record<string, string> {
  const u = (f: string) => pathToFileURL(join(STUB_DIR, f)).href;
  const m: Record<string, string> = {};
  if (s.bundler) m["/src/passes/bundler-unpack.ts"] = u("stub-bundler-throw.mjs");
  if (s.hex) m["/src/passes/hex-decode.ts"] = u("stub-hex-empty.mjs");
  if (s.format) m["/src/passes/format.ts"] = u("stub-format-throw.mjs");
  if (s.entropy) m["/src/entropy.ts"] = u("stub-entropy-throw.mjs");
  return m;
}

beforeAll(() => {
  STUB_DIR = temps.make("clisafe-stubs-");
  for (const [name, text] of Object.entries(STUB_SOURCES)) fs.writeFileSync(join(STUB_DIR, name), text);
});

/** Remove the temporary directories once every FIFO writer started by this file has exited. */
afterAll(async () => {
  await Promise.all(writers.map(exited));
  temps.removeAll();
});

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => child.once("exit", () => done()));
}

interface RunOpts {
  cwd?: string;
  stubs?: Stubs;
  stdoutFd?: number;
  merged?: boolean;
  /** run the CLI with stdout on a real pipe (bash | cat) instead of the socket Node uses for "pipe" */
  realPipe?: boolean;
  timeout?: number;
}
interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stdoutText: string;
  stderr: string;
  stderrLines: string[];
}

function lines(text: string): string[] {
  const l = text.split("\n");
  if (l.length > 0 && l[l.length - 1] === "") l.pop();
  return l;
}

function nodeArgs(args: string[], o: RunOpts, env: NodeJS.ProcessEnv): string[] {
  const a = ["--import", TSX_LOADER];
  if (o.stubs) {
    a.push("--import", pathToFileURL(join(STUB_DIR, "preload.mjs")).href);
    env.DEOBF_TEST_STUBS = JSON.stringify(stubMap(o.stubs));
    if (o.stubs.entropy) env.DEOBF_TEST_THROW = o.stubs.entropy;
  }
  return [...a, ENTRY, ...args];
}

function runCli(args: string[], o: RunOpts = {}): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const na = nodeArgs(args, o, env);
  const [cmd, argv] = o.merged
    ? ["bash", ["-c", 'exec "$@" 2>&1', "bash", process.execPath, ...na]]
    : o.realPipe
      ? ["bash", ["-c", '"$@" | cat; exit "${PIPESTATUS[0]}"', "bash", process.execPath, ...na]]
      : [process.execPath, na];
  const r = spawnSync(cmd, argv as string[], {
    cwd: o.cwd ?? ROOT,
    env,
    timeout: o.timeout ?? SPAWN_TIMEOUT,
    stdio: ["ignore", o.stdoutFd ?? "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
  const stdout = (r.stdout as Buffer | null) ?? Buffer.alloc(0);
  const stderr = ((r.stderr as Buffer | null) ?? Buffer.alloc(0)).toString("utf-8");
  return { status: r.status, signal: r.signal, stdout, stdoutText: stdout.toString("utf-8"), stderr, stderrLines: lines(stderr) };
}

function tmp(): string {
  return temps.make("clisafe-");
}

function sha(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function errorLines(r: RunResult): string[] {
  return r.stderrLines.filter((l) => l.startsWith("ERROR:"));
}

function stackLines(r: RunResult): string[] {
  return r.stderrLines.filter((l) => /^\s+at /.test(l));
}

function hasDone(r: RunResult): boolean {
  return /^Done: /m.test(r.stdoutText) || /^Done: /m.test(r.stderr);
}

/** The shape every refusal shares: status 1, one ERROR line, last on stderr, no Done, no stack trace. */
function expectRefusal(r: RunResult, reason: Reason, label = ""): string {
  expect(r.signal, label).toBeNull();
  expect(r.status, `${label} status; stderr:\n${r.stderr}`).toBe(1);
  const errs = errorLines(r);
  expect(errs, `${label} ERROR lines; stderr:\n${r.stderr}`).toHaveLength(1);
  expect(r.stderrLines[r.stderrLines.length - 1], label).toBe(errs[0]);
  expect(errs[0], label).toMatch(D[reason]);
  expect(hasDone(r), label).toBe(false);
  expect(stackLines(r), label).toEqual([]);
  if (!collected[reason]) collected[reason] = errs[0];
  return errs[0];
}

function expectAccept(r: RunResult, label = ""): void {
  expect(r.signal, label).toBeNull();
  expect(r.status, `${label} status; stderr:\n${r.stderr}`).toBe(0);
  expect(errorLines(r), label).toEqual([]);
  expect(lines(r.stdoutText).filter((l) => l.startsWith("Done: ")), label).toHaveLength(1);
}

type Cls = "C1" | "C2" | "C3" | "C4" | "DONE" | "?";
function classify(line: string): Cls {
  if (line === UNSAFE_NOTICE) return "C1";
  if (line.startsWith("WARNING: ")) return "C2";
  if (line === "" || /^Pipeline: \d+ iteration\(s\), entropy /.test(line) || line === "Pass report:" || /^ {2}[\w-]+: (changed|no change)$/.test(line) || /^\s+at /.test(line)) return "C3";
  if (line.startsWith("ERROR: ")) return "C4";
  if (line.startsWith("Done: ")) return "DONE";
  return "?";
}
const ORDER: Cls[] = ["C1", "C2", "C3", "C4", "DONE"];
function expectClassOrder(stderrLines: string[], label = ""): Cls[] {
  const cls = stderrLines.map(classify);
  expect(cls.filter((c) => c === "?"), `${label} unclassified stderr lines:\n${stderrLines.join("\n")}`).toEqual([]);
  for (let i = 1; i < cls.length; i++) {
    expect(ORDER.indexOf(cls[i]), `${label} class order at stderr line ${i}:\n${stderrLines.join("\n")}`).toBeGreaterThanOrEqual(ORDER.indexOf(cls[i - 1]));
  }
  return cls;
}

function startFifoWriter(fifo: string, shellProducer: string) {
  const child = spawn("bash", ["-c", `${shellProducer} > "$1"`, "bash", fifo], { stdio: "ignore" });
  writers.push(child);
  return child;
}

// ---------------------------------------------------------------------------
// same-file refusal and its precedence
// ---------------------------------------------------------------------------

describe("same-file refusal before the pipeline", () => {
  type Setup = { args: string[]; cwd?: string; given: string[]; file: string; isDir?: boolean };
  const cases: Array<[string, (d: string) => Setup]> = [
    ["identical literal path", (d) => {
      const f = join(d, "in.js");
      fs.writeFileSync(f, RECOVERABLE);
      return { args: [f, f], given: [f], file: f };
    }],
    ["relative and absolute spelling", (d) => {
      const f = join(d, "in.js");
      fs.writeFileSync(f, RECOVERABLE);
      return { args: ["in.js", f], cwd: d, given: ["in.js", f], file: f };
    }],
    ["symlink to the input", (d) => {
      const f = join(d, "in.js");
      const l = join(d, "link.js");
      fs.writeFileSync(f, RECOVERABLE);
      fs.symlinkSync(f, l);
      return { args: [f, l], given: [f, l], file: f };
    }],
    ["symlink chain to the input", (d) => {
      const f = join(d, "in.js");
      const l1 = join(d, "link1.js");
      const l2 = join(d, "link2.js");
      fs.writeFileSync(f, RECOVERABLE);
      fs.symlinkSync(f, l1);
      fs.symlinkSync(l1, l2);
      return { args: [f, l2], given: [f, l2], file: f };
    }],
    ["hard link to the input", (d) => {
      const f = join(d, "in.js");
      const h = join(d, "hard.js");
      fs.writeFileSync(f, RECOVERABLE);
      fs.linkSync(f, h);
      return { args: [f, h], given: [f, h], file: f };
    }],
    ["empty file as both input and output (precedence over empty input)", (d) => {
      const f = join(d, "empty.js");
      fs.writeFileSync(f, "");
      return { args: [f, f], given: [f], file: f };
    }],
    ["directory as both input and output (precedence over the directory refusal)", (d) => {
      const dir = join(d, "adir");
      fs.mkdirSync(dir);
      return { args: [dir, dir], given: [dir], file: dir, isDir: true };
    }],
  ];

  it.each(cases)("refuses %s with status 1, one same-file ERROR naming the paths, input untouched", (label, make) => {
    const d = tmp();
    const s = make(d);
    const before = s.isDir ? JSON.stringify(fs.readdirSync(s.file)) : sha(s.file);
    const sizeBefore = s.isDir ? 0 : fs.statSync(s.file).size;
    const r = runCli(s.args, { cwd: s.cwd });
    const line = expectRefusal(r, "SAME", label);
    for (const p of s.given) expect(line, label).toContain(p);
    expect(r.stderrLines.filter((l) => l.startsWith("WARNING:")), `${label}: pipeline must not run`).toEqual([]);
    if (s.isDir) {
      expect(JSON.stringify(fs.readdirSync(s.file))).toBe(before);
    } else {
      expect(sha(s.file)).toBe(before);
      expect(fs.statSync(s.file).size).toBe(sizeBefore);
    }
  }, SPAWN_TIMEOUT);

  it("witness: the same input with a distinct output (absent, or existing distinct) is processed", () => {
    const d = tmp();
    const f = join(d, "in.js");
    fs.writeFileSync(f, RECOVERABLE);
    const absent = join(d, "out-absent.js");
    const existing = join(d, "out-existing.js");
    fs.writeFileSync(existing, "OLD CONTENT");
    for (const out of [absent, existing]) {
      const r = runCli([f, out]);
      expectAccept(r, out);
      expect(fs.readFileSync(out, "utf-8")).toContain("console.log");
      expect(r.stderrLines.some((l) => l.startsWith("WARNING: Parse error (recovered)"))).toBe(true);
    }
  }, SPAWN_TIMEOUT);
});

describe("identity unknown at the early check", () => {
  it.each([
    ["an output under a regular file (ENOTDIR)", "ENOTDIR", (d: string, input: string) => join(input, "out.js")],
    ["a symlink loop as output (ELOOP)", "ELOOP", (d: string) => {
      const a = join(d, "loopA");
      const b = join(d, "loopB");
      fs.symlinkSync(b, a);
      fs.symlinkSync(a, b);
      return a;
    }],
  ] as Array<[string, string, (d: string, input: string) => string]>)("refuses %s before the pipeline, naming the output path and %s", (_label, code, makeOut) => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, RECOVERABLE);
    const before = sha(input);
    const out = makeOut(d, input);
    const r = runCli([input, out]);
    const line = expectRefusal(r, "IDUNK");
    expect(line).toContain(out);
    expect(line).toMatch(new RegExp(`\\b${code}\\b`));
    expect(r.stderrLines.filter((l) => l.startsWith("WARNING:"))).toEqual([]);
    expect(sha(input)).toBe(before);
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// input refusals
// ---------------------------------------------------------------------------

describe("missing, unreadable or directory input", () => {
  it("refuses a nonexistent input with one ERROR naming the path and ENOENT; a pre-existing distinct output keeps its bytes", () => {
    const d = tmp();
    const input = join(d, "missing.js");
    const out = join(d, "out.js");
    fs.writeFileSync(out, "PRE-EXISTING");
    const r = runCli([input, out]);
    const line = expectRefusal(r, "INPUT");
    expect(r.stderrLines).toHaveLength(1);
    expect(line).toContain(input);
    expect(line).toMatch(/\bENOENT\b/);
    expect(fs.readFileSync(out, "utf-8")).toBe("PRE-EXISTING");
  }, SPAWN_TIMEOUT);

  it("refuses a dangling-symlink input (ENOENT) and leaves an absent output absent", () => {
    const d = tmp();
    const link = join(d, "dangling.js");
    fs.symlinkSync(join(d, "nowhere.js"), link);
    const out = join(d, "out.js");
    const r = runCli([link, out]);
    const line = expectRefusal(r, "INPUT");
    expect(line).toContain(link);
    expect(line).toMatch(/\bENOENT\b/);
    expect(fs.existsSync(out)).toBe(false);
  }, SPAWN_TIMEOUT);

  it.skipIf(IS_ROOT)("refuses an unreadable input (EACCES)", () => {
    const d = tmp();
    const input = join(d, "secret.js");
    fs.writeFileSync(input, "var a = 1;");
    fs.chmodSync(input, 0o000);
    const out = join(d, "out.js");
    try {
      const r = runCli([input, out]);
      const line = expectRefusal(r, "INPUT");
      expect(line).toContain(input);
      expect(line).toMatch(/\bEACCES\b/);
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      fs.chmodSync(input, 0o600);
    }
  }, SPAWN_TIMEOUT);

  it("refuses a directory input with a distinct output as 'is a directory'", () => {
    const d = tmp();
    const dir = join(d, "srcdir");
    fs.mkdirSync(dir);
    const out = join(d, "out.js");
    const r = runCli([dir, out]);
    const line = expectRefusal(r, "INPUT");
    expect(line).toContain(dir);
    expect(line).toMatch(/is a directory/i);
    expect(fs.existsSync(out)).toBe(false);
  }, SPAWN_TIMEOUT);

  it("reports in = out = a nonexistent path as an input refusal, never as same-file", () => {
    const d = tmp();
    const p = join(d, "ghost.js");
    const r = runCli([p, p]);
    const line = expectRefusal(r, "INPUT");
    expect(line).not.toMatch(D.SAME);
    expect(fs.existsSync(p)).toBe(false);
  }, SPAWN_TIMEOUT);

  it("witness: /dev/null and a FIFO are accepted as input", () => {
    const d = tmp();
    const out1 = join(d, "out-null.js");
    const r1 = runCli(["/dev/null", out1]);
    expectAccept(r1, "/dev/null input");
    expect(fs.existsSync(out1)).toBe(true);

    const fifo = join(d, "in.fifo");
    execFileSync("mkfifo", [fifo]);
    const writer = startFifoWriter(fifo, "printf 'var fromFifo = 1;\\nconsole.log(fromFifo);\\n'");
    const out2 = join(d, "out-fifo.js");
    try {
      const r2 = runCli([fifo, out2]);
      expectAccept(r2, "fifo input");
      expect(fs.readFileSync(out2, "utf-8")).toContain("console.log");
    } finally {
      writer.kill();
    }
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// size cap on bytes read
// ---------------------------------------------------------------------------

describe("20MB cap on the bytes read", () => {
  it("refuses a regular file of MAX + 1 bytes with the size message naming the path", () => {
    const d = tmp();
    const input = join(d, "big.js");
    fs.writeFileSync(input, " ".repeat(MAX + 1));
    const out = join(d, "out.js");
    const r = runCli([input, out]);
    const line = expectRefusal(r, "SIZE");
    expect(line).toMatch(/exceeds.*max/i);
    expect(line).toContain(input);
    expect(fs.existsSync(out)).toBe(false);
  }, SPAWN_TIMEOUT);

  it("refuses /dev/zero as input with the size message and terminates", () => {
    const d = tmp();
    const out = join(d, "out.js");
    const r = runCli(["/dev/zero", out], { timeout: 30000 });
    const line = expectRefusal(r, "SIZE");
    expect(line).toContain("/dev/zero");
    expect(fs.existsSync(out)).toBe(false);
  }, SPAWN_TIMEOUT);

  it("refuses a FIFO fed MAX + 1 bytes", () => {
    const d = tmp();
    const fifo = join(d, "big.fifo");
    execFileSync("mkfifo", [fifo]);
    const writer = startFifoWriter(fifo, `head -c ${MAX + 1} /dev/zero | tr '\\0' ' '`);
    const out = join(d, "out.js");
    try {
      const r = runCli([fifo, out], { timeout: 30000 });
      const line = expectRefusal(r, "SIZE");
      expect(line).toContain(fifo);
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      writer.kill();
    }
  }, SPAWN_TIMEOUT);

  it("witness: an input of exactly MAX bytes passes the size check", () => {
    const d = tmp();
    const input = join(d, "exact.js");
    fs.writeFileSync(input, " ".repeat(MAX));
    const out = join(d, "out.js");
    const r = runCli([input, out]);
    expectAccept(r, "exactly MAX");
    expect(fs.existsSync(out)).toBe(true);
  }, SPAWN_TIMEOUT);

  it("decodes the bytes once after the full read (multi-byte characters across read chunks stay intact)", () => {
    const d = tmp();
    const input = join(d, "mb.js");
    fs.writeFileSync(input, `var s = "${"é".repeat(150000)}";\nconsole.log(s);\n`);
    const out = join(d, "out.js");
    const r = runCli([input, out]);
    expectAccept(r, "multi-byte");
    const text = fs.readFileSync(out, "utf-8");
    expect(text).not.toContain("�");
    expect(text.split("é").length - 1).toBe(150000);
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// parse outcome refusals
// ---------------------------------------------------------------------------

describe("unparseable and partially parsed input", () => {
  it.each([
    ["the empty-program fallback at line 1", "@@@", "PARSE_EMPTY", 1, false],
    ["the empty-program fallback after a failing prefix (line 3)", 'var s = "ok";\nfunction f() {\n@@@', "PARSE_EMPTY", 3, true],
    ["the truncation fallback (line 2)", "var keep = 1;\n@@@", "PARSE_TRUNC", 2, true],
    ["a truncated input whose prefix would be emptied (truncation precedes emptiness)", "if (false) { x(); }\n@@@", "PARSE_TRUNC", 2, false],
  ] as Array<[string, string, Reason, number, boolean]>)("refuses %s, naming the line and the input path, output untouched", (label, src, reason, lineNo, prior) => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, src);
    const out = join(d, "out.js");
    if (prior) fs.writeFileSync(out, "PRE-EXISTING");
    const r = runCli([input, out]);
    const line = expectRefusal(r, reason, label);
    expect(line).toContain(`line ${lineNo}`);
    expect(line).toContain(input);
    expect(line).not.toMatch(D.EMPTY);
    if (prior) expect(fs.readFileSync(out, "utf-8")).toBe("PRE-EXISTING");
    else expect(fs.existsSync(out)).toBe(false);
  }, SPAWN_TIMEOUT);

  it("witness: an error-recovered input is accepted with WARNING lines and an output", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, RECOVERABLE);
    const out = join(d, "out.js");
    const r = runCli([input, out]);
    expectAccept(r);
    expect(r.stderrLines.some((l) => l.startsWith("WARNING: Parse error (recovered)"))).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// emptiness
// ---------------------------------------------------------------------------

describe("non-empty input yielding no statements", () => {
  it("refuses dead-code-only input with the all-statements-removed message", () => {
    const d = tmp();
    const input = join(d, "dead.js");
    fs.writeFileSync(input, "if (false) { x(); }\n");
    const out = join(d, "out.js");
    const r = runCli([input, out]);
    const line = expectRefusal(r, "EMPTY");
    expect(line).toContain(input);
    expect(fs.existsSync(out)).toBe(false);
  }, SPAWN_TIMEOUT);

  it("refuses when a pass empties the program even though a comment banner survives; the distinct output keeps its bytes", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, PLAIN);
    const out = join(d, "out.js");
    fs.writeFileSync(out, "PRE-EXISTING");
    const r = runCli([input, out], { stubs: { hex: "empty" } });
    expectRefusal(r, "EMPTY");
    expect(fs.readFileSync(out, "utf-8")).toBe("PRE-EXISTING");
  }, SPAWN_TIMEOUT);

  it.each([
    ["a 0-byte input", ""],
    ["a whitespace-only input", "   \n\t\n"],
    ["a comments-only input", "// only a comment\n/* and a block */\n"],
  ])("witness: %s with a distinct output is accepted and written", (_label, src) => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, src);
    const out = join(d, "out.js");
    const r = runCli([input, out]);
    expectAccept(r);
    expect(fs.existsSync(out)).toBe(true);
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// skipped pass at the CLI
// ---------------------------------------------------------------------------

describe("a throwing pass is skipped with a warning", () => {
  it("an AST pass that mutates and throws: exit 0, WARNING naming pass and message, output equal to the run without the failure", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, PLAIN);
    const outStub = join(d, "out-stub.js");
    const outRef = join(d, "out-ref.js");
    const r = runCli([input, outStub], { stubs: { bundler: "throw" } });
    expectAccept(r);
    const warnings = r.stderrLines.filter((l) => l.startsWith("WARNING: "));
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(w).toBe("WARNING: bundler-unpack: stub pass failure");
    expectAccept(runCli([input, outRef]), "reference run");
    expect(fs.readFileSync(outStub, "utf-8")).toBe(fs.readFileSync(outRef, "utf-8"));
    expect(fs.readFileSync(outStub, "utf-8")).not.toContain("INJECTED_BY_THROWING_STUB");
  }, SPAWN_TIMEOUT);

  it("the format pass throwing: exit 0, WARNING, unformatted text written", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, "console.log(1);\n");
    const out = join(d, "out.js");
    const r = runCli([input, out], { stubs: { format: "throw" } });
    expectAccept(r);
    expect(r.stderrLines).toContain("WARNING: format: stub format failure");
    expect(fs.readFileSync(out, "utf-8")).toBe("console.log(1);");
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// reporting shape: class order matrix
// ---------------------------------------------------------------------------

describe("exit status and stderr class order on every outcome", () => {
  const FLAGS: Array<[string, string[]]> = [
    ["no flags", []],
    ["--unsafe", ["--unsafe"]],
    ["--verbose", ["--verbose"]],
    ["--unsafe --verbose", ["--unsafe", "--verbose"]],
  ];
  const OUTCOMES = ["ACCEPT after a skipped pass", "EMPTY refusal after a skipped pass", "SAME refusal"] as const;
  const rows = FLAGS.flatMap(([fl, flags]) => OUTCOMES.map((o) => [`${o} with ${fl}`, flags, o] as [string, string[], (typeof OUTCOMES)[number]]));

  it.each(rows)("%s", (label, flags, outcome) => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, PLAIN);
    const out = outcome === "SAME refusal" ? input : join(d, "out.js");
    const stubs: Stubs = outcome === "EMPTY refusal after a skipped pass" ? { bundler: "throw", hex: "empty" } : { bundler: "throw" };
    const r = runCli([...flags, input, out], { stubs });
    const unsafe = flags.includes("--unsafe");
    const verbose = flags.includes("--verbose");
    const cls = expectClassOrder(r.stderrLines, label);
    expect(cls[0] === "C1", `${label}: --unsafe notice first`).toBe(unsafe);
    expect(cls.filter((c) => c === "C1").length, label).toBe(unsafe ? 1 : 0);
    expect(cls.includes("DONE"), `${label}: Done never on stderr here`).toBe(false);
    if (outcome === "SAME refusal") {
      expectRefusal(r, "SAME", label);
      expect(cls.filter((c) => c === "C2" || c === "C3"), `${label}: no pipeline output for a pre-pipeline refusal`).toEqual([]);
      expect(r.stdoutText).toBe("");
      return;
    }
    expect(r.stderrLines, label).toContain("WARNING: bundler-unpack: stub pass failure");
    expect(cls.includes("C3"), `${label}: verbose report`).toBe(verbose);
    if (verbose) {
      expect(r.stderrLines.some((l) => /^Pipeline: \d+ iteration\(s\), entropy /.test(l)), label).toBe(true);
      expect(r.stderrLines, label).toContain("Pass report:");
    }
    if (outcome === "EMPTY refusal after a skipped pass") {
      expectRefusal(r, "EMPTY", label);
      expect(r.stdoutText).toBe("");
    } else {
      expectAccept(r, label);
      expect(cls.includes("C4"), label).toBe(false);
      expect(lines(r.stdoutText), `${label}: stdout carries only the Done line`).toHaveLength(1);
    }
  }, SPAWN_TIMEOUT);

  it("merged-fd capture of a success: Done follows every stderr line", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, PLAIN);
    const out = join(d, "out.js");
    const r = runCli(["--unsafe", "--verbose", input, out], { stubs: { bundler: "throw" }, merged: true });
    expect(r.status).toBe(0);
    const merged = lines(r.stdoutText);
    expect(merged.filter((l) => l.startsWith("Done: "))).toHaveLength(1);
    expect(merged[merged.length - 1]).toMatch(/^Done: /);
    expect(merged[0]).toBe(UNSAFE_NOTICE);
    expect(merged).toContain("WARNING: bundler-unpack: stub pass failure");
  }, SPAWN_TIMEOUT);

  it("a refusal after a large amount of stderr output delivers complete stderr through a pipe", () => {
    const d = tmp();
    const input = join(d, "in.js");
    const N = 1500;
    const body = Array.from({ length: N }, (_, i) => `var await = ${i};`).join("\n");
    fs.writeFileSync(input, body + "\n");
    const out = join(d, "out.js");
    const r = runCli([input, out], { stubs: { hex: "empty" } });
    expectRefusal(r, "EMPTY");
    expect(r.stderr.endsWith("\n")).toBe(true);
    expect(r.stderrLines.filter((l) => l.startsWith("WARNING: Parse error (recovered)")).length).toBeGreaterThanOrEqual(N);
    expect(fs.existsSync(out)).toBe(false);
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// output targets and the Done stream
// ---------------------------------------------------------------------------

describe("output targets and the Done destination", () => {
  function referenceOutput(d: string, src: string): { input: string; bytes: Buffer } {
    const input = join(d, "in.js");
    fs.writeFileSync(input, src);
    const ref = join(d, "ref.js");
    const r = runCli([input, ref]);
    expectAccept(r, "reference");
    expect(r.stderrLines.some((l) => l.startsWith("Done: ")), "reference run: Done not on stderr").toBe(false);
    return { input, bytes: fs.readFileSync(ref) };
  }

  it("output /dev/stdout with stdout a pipe: stdout carries exactly the output, Done is the last stderr line", () => {
    const d = tmp();
    const { input, bytes } = referenceOutput(d, PLAIN);
    const r = runCli([input, "/dev/stdout"], { realPipe: true });
    expect(r.status).toBe(0);
    expect(r.stdout.equals(bytes), `stdout was:\n${r.stdoutText}`).toBe(true);
    expect(r.stderrLines[r.stderrLines.length - 1]).toMatch(/^Done: /);
    expect(errorLines(r)).toEqual([]);
  }, SPAWN_TIMEOUT);

  it("stdout redirected to the output file F: F holds exactly the output, Done on stderr", () => {
    const d = tmp();
    const { input, bytes } = referenceOutput(d, PLAIN);
    const F = join(d, "redirected.js");
    const fd = fs.openSync(F, "w");
    let r: RunResult;
    try {
      r = runCli([input, F], { stdoutFd: fd });
    } finally {
      fs.closeSync(fd);
    }
    expect(r.status).toBe(0);
    expect(fs.readFileSync(F).equals(bytes), `F was:\n${fs.readFileSync(F, "utf-8")}`).toBe(true);
    expect(r.stderrLines[r.stderrLines.length - 1]).toMatch(/^Done: /);
  }, SPAWN_TIMEOUT);

  it("witness: output /dev/null exits 0 with Done on stdout and no ERROR", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, PLAIN);
    const r = runCli([input, "/dev/null"], { realPipe: true });
    expectAccept(r, "/dev/null output");
    expect(r.stderrLines.some((l) => l.startsWith("Done: "))).toBe(false);
  }, SPAWN_TIMEOUT);

  it("refuses a directory output at open: status 1, one write ERROR naming the path and EISDIR, nothing written", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, PLAIN);
    const outDir = join(d, "outdir");
    fs.mkdirSync(outDir);
    const r = runCli([input, outDir]);
    const line = expectRefusal(r, "WRITE");
    expect(line).toContain(outDir);
    expect(line).toMatch(/\bEISDIR\b/);
    expect(fs.readdirSync(outDir)).toEqual([]);
  }, SPAWN_TIMEOUT);

  it("an output symlink to a missing file creates that file with the output and exits 0; one into a missing directory is refused with the open ENOENT line", () => {
    const d = tmp();
    const { input, bytes } = referenceOutput(d, PLAIN);

    const intoMissing = join(d, "into-missing.js");
    fs.symlinkSync(join(d, "no-such-dir", "out.js"), intoMissing);
    const r1 = runCli([input, intoMissing]);
    expectRefusal(r1, "WRITE", "symlink into a missing directory");
    expect(r1.stderrLines[r1.stderrLines.length - 1]).toBe(`ERROR: Writing output failed: ${intoMissing} (open: ENOENT); nothing was written to the output`);
    expect(fs.existsSync(join(d, "no-such-dir"))).toBe(false);

    const link = join(d, "link.js");
    const target = join(d, "missing-target.js");
    fs.symlinkSync(target, link);
    const r2 = runCli([input, link]);
    expectAccept(r2, "symlink to a missing file");
    expect(fs.readFileSync(target).equals(bytes), `target was:\n${fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "(absent)"}`).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lines(r2.stdoutText)[0]).toContain(`→ ${link} (`);
    expect(r2.stderrLines.some((l) => l.startsWith("Done: "))).toBe(false);
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// unexpected internal error
// ---------------------------------------------------------------------------

describe("unexpected internal error", () => {
  function setup(prior: boolean) {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, PLAIN);
    const out = join(d, "out.js");
    if (prior) fs.writeFileSync(out, "PRE-EXISTING");
    return { input, out, inSha: sha(input) };
  }

  it("reports one ERROR: internal error line with the whole message on one line and the input path, after the warnings, no stack", () => {
    const { input, out, inSha } = setup(false);
    const r = runCli([input, out], { stubs: { bundler: "throw", entropy: "multiline" } });
    const line = expectRefusal(r, "INTERNAL");
    expect(line).toContain("internal stub failure");
    expect(line).toContain("second line");
    expect(line).toContain("third line");
    expect(line).toContain(input);
    const iWarn = r.stderrLines.indexOf("WARNING: bundler-unpack: stub pass failure");
    expect(iWarn).toBeGreaterThanOrEqual(0);
    expect(iWarn).toBeLessThan(r.stderrLines.indexOf(line));
    expectClassOrder(r.stderrLines);
    expect(fs.existsSync(out)).toBe(false);
    expect(sha(input)).toBe(inSha);
  }, SPAWN_TIMEOUT);

  it("with --unsafe --verbose: notice first, stack lines only before the ERROR line; a pre-existing output keeps its bytes", () => {
    const { input, out, inSha } = setup(true);
    const r = runCli(["--unsafe", "--verbose", input, out], { stubs: { bundler: "throw", entropy: "multiline" } });
    expect(r.status).toBe(1);
    const errs = errorLines(r);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(D.INTERNAL);
    expect(r.stderrLines[r.stderrLines.length - 1]).toBe(errs[0]);
    expect(r.stderrLines[0]).toBe(UNSAFE_NOTICE);
    const iErr = r.stderrLines.indexOf(errs[0]);
    const stackIdx = r.stderrLines.map((l, i) => (/^\s+at /.test(l) ? i : -1)).filter((i) => i >= 0);
    expect(stackIdx.length).toBeGreaterThan(0);
    for (const i of stackIdx) expect(i).toBeLessThan(iErr);
    const iWarn = r.stderrLines.indexOf("WARNING: bundler-unpack: stub pass failure");
    expect(iWarn).toBeGreaterThan(0);
    expect(iWarn).toBeLessThan(Math.min(...stackIdx));
    expect(hasDone(r)).toBe(false);
    expect(fs.readFileSync(out, "utf-8")).toBe("PRE-EXISTING");
    expect(sha(input)).toBe(inSha);
  }, SPAWN_TIMEOUT);

  it("names the Node error code carried by the error", () => {
    const { input, out } = setup(false);
    const r = runCli([input, out], { stubs: { entropy: "code" } });
    const line = expectRefusal(r, "INTERNAL");
    expect(line).toContain("internal stub io trouble");
    expect(line).toMatch(/\bEIO\b/);
    expect(line).toContain(input);
  }, SPAWN_TIMEOUT);

  it("reports a thrown non-Error value through its string form", () => {
    const { input, out } = setup(false);
    const r = runCli([input, out], { stubs: { entropy: "string" } });
    const line = expectRefusal(r, "INTERNAL");
    expect(line).toContain("internal stub thrown string");
    expect(fs.existsSync(out)).toBe(false);
  }, SPAWN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// message discriminators
// ---------------------------------------------------------------------------

describe("ERROR lines stay pairwise distinguishable", () => {
  it("each collected refusal line matches its own discriminator and no other", () => {
    const reasons = Object.keys(D) as Reason[];
    expect(Object.keys(collected).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      const line = collected[reason]!;
      const matching = reasons.filter((other) => D[other].test(line));
      expect(matching, `${reason}: ${line}`).toEqual([reason]);
    }
    expect(collected.SIZE).toMatch(/exceeds.*max/i);
  });
});

// ---------------------------------------------------------------------------
// static source checks
// ---------------------------------------------------------------------------

describe("static checks of the CLI source", () => {
  const index = () => fs.readFileSync(ENTRY, "utf-8");

  it("src/index.ts never calls process.exit()", () => {
    expect(index()).not.toMatch(/process\.exit\s*\(/);
  });

  it("src/index.ts writes only through src/cli/safe-output.ts and reads the input only through its single descriptor", () => {
    const src = index();
    expect(src).toMatch(/from\s+["']\.\/cli\/safe-output\.js["']/);
    expect(src).not.toMatch(/\b(writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|truncateSync|copyFileSync|mkdirSync|chmodSync|createWriteStream|readFileSync|statSync|lstatSync)\b/);
  });

  it("no refusal decision in src/index.ts or src/pipeline.ts matches parser warning text", () => {
    for (const f of ["src/index.ts", "src/pipeline.ts"]) {
      const src = fs.readFileSync(join(ROOT, f), "utf-8");
      expect(src, f).not.toMatch(/Could not parse|Truncated at/);
    }
  });
});
