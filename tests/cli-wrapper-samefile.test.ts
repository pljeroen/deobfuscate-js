/**
 * Benchmark wrapper scripts/deobfuscate-js.sh: alias refusal at start, the
 * pre-fallback re-check, and the checked empty-output fallback.
 *
 * A PATH shim named `npx` stands in for the CLI where the test needs the CLI
 * to fail in a controlled way (and, for the re-check, to create the alias
 * while it runs). The shim records each invocation in a marker file.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { TempDirs } from "./temp-dirs.js";

const ROOT = resolve(import.meta.dirname, "..");
const WRAPPER = join(ROOT, "scripts", "deobfuscate-js.sh");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const TIMEOUT = 90000;

const temps = new TempDirs();
afterAll(() => temps.removeAll());

function tmp(): string {
  return temps.make("wrapsafe-");
}

function sha(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

type ShimMode = "fail" | "fail-after-hardlink" | "fail-after-symlink" | "succeed-without-output";

/** Write an `npx` shim; the CLI arguments end with "<INPUT> <OUTPUT>". */
function shim(dir: string, mode: ShimMode): { bin: string; marker: string } {
  const bin = join(dir, "shim-bin");
  fs.mkdirSync(bin);
  const marker = join(dir, "shim-invoked");
  const action: Record<ShimMode, string> = {
    fail: "exit 1",
    "fail-after-hardlink": 'ln "$in" "$out"; exit 1',
    "fail-after-symlink": 'ln -s "$in" "$out"; exit 1',
    "succeed-without-output": "exit 0",
  };
  fs.writeFileSync(
    join(bin, "npx"),
    `#!/bin/bash\nin="\${@: -2:1}"\nout="\${@: -1}"\necho invoked >> "${marker}"\n${action[mode]}\n`,
    { mode: 0o755 },
  );
  return { bin, marker };
}

function runWrapper(input: string, output: string, pathPrefix?: string) {
  const env = { ...process.env };
  if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH ?? ""}`;
  const r = spawnSync("bash", [WRAPPER, input, output], { env, timeout: TIMEOUT, encoding: "utf-8" });
  return { status: r.status, stderr: r.stderr ?? "", errorLines: (r.stderr ?? "").split("\n").filter((l) => l.startsWith("ERROR")) };
}

describe("wrapper alias refusal at start", () => {
  it.each([
    ["identical literal path", (_d: string, input: string) => input],
    ["a symlink to the input", (d: string, input: string) => {
      const l = join(d, "link.js");
      fs.symlinkSync(input, l);
      return l;
    }],
    ["a hard link to the input", (d: string, input: string) => {
      const h = join(d, "hard.js");
      fs.linkSync(input, h);
      return h;
    }],
  ] as Array<[string, (d: string, input: string) => string]>)("exits 1 for %s with an ERROR naming both paths, without running the CLI or writing", (_label, makeOut) => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, "var keep = 'me';\n");
    const before = sha(input);
    const output = makeOut(d, input);
    const s = shim(d, "fail");
    const r = runWrapper(input, output, s.bin);
    expect(r.status).toBe(1);
    expect(r.errorLines.length).toBeGreaterThan(0);
    expect(r.errorLines.some((l) => l.includes(input) && l.includes(output))).toBe(true);
    expect(sha(input)).toBe(before);
    expect(fs.existsSync(s.marker)).toBe(false);
  }, TIMEOUT);

  it("witness: distinct paths with a failing CLI run the CLI, write an empty regular output and exit 0", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, "var keep = 'me';\n");
    const output = join(d, "out.js");
    const s = shim(d, "fail");
    const r = runWrapper(input, output, s.bin);
    expect(r.status).toBe(0);
    expect(fs.existsSync(s.marker)).toBe(true);
    expect(fs.statSync(output).isFile()).toBe(true);
    expect(fs.readFileSync(output, "utf-8")).toBe("");
  }, TIMEOUT);
});

describe("wrapper re-check before the fallback", () => {
  it.each([
    ["hard link", "fail-after-hardlink"],
    ["symlink", "fail-after-symlink"],
  ] as Array<[string, ShimMode]>)("a CLI that creates a %s alias and fails makes the wrapper exit 1 without truncating the input", (_label, mode) => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, "var keep = 'me';\n");
    const before = sha(input);
    const output = join(d, "out.js");
    const s = shim(d, mode);
    const r = runWrapper(input, output, s.bin);
    expect(fs.existsSync(s.marker)).toBe(true);
    expect(r.status).toBe(1);
    expect(sha(input)).toBe(before);
    expect(fs.statSync(input).size).toBeGreaterThan(0);
    expect(r.errorLines.some((l) => l.includes(input) && l.includes(output))).toBe(true);
  }, TIMEOUT);

  it("witness: a CLI that exits 0 without leaving a regular output gets the empty fallback and exit 0", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, "var keep = 'me';\n");
    const output = join(d, "out.js");
    const s = shim(d, "succeed-without-output");
    const r = runWrapper(input, output, s.bin);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(output, "utf-8")).toBe("");
  }, TIMEOUT);
});

describe("checked fallback redirection", () => {
  it.skipIf(IS_ROOT)("exits 1 with an ERROR naming OUTPUT when the empty-output redirection fails", () => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, "var keep = 'me';\n");
    const locked = join(d, "locked");
    fs.mkdirSync(locked);
    const output = join(locked, "out.js");
    fs.chmodSync(locked, 0o500);
    try {
      const s = shim(d, "fail");
      const r = runWrapper(input, output, s.bin);
      expect(r.status).toBe(1);
      expect(fs.existsSync(output)).toBe(false);
      expect(r.errorLines.some((l) => l.includes(output))).toBe(true);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  }, TIMEOUT);

  it("a missing input with a distinct output still yields exit 0 and an empty output (real CLI)", () => {
    const d = tmp();
    const input = join(d, "missing.js");
    const output = join(d, "out.js");
    const r = runWrapper(input, output);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(output, "utf-8")).toBe("");
  }, TIMEOUT);

  it.each([
    ["a truncated-prefix input", "console.log(1);\n@@@"],
    ["a non-empty input whose final program is empty", "if (false) { x(); }\n"],
  ])("authorized byte change: %s yields an empty output and exit 0 (real CLI)", (_label, src) => {
    const d = tmp();
    const input = join(d, "in.js");
    fs.writeFileSync(input, src);
    const output = join(d, "out.js");
    const r = runWrapper(input, output);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(output, "utf-8")).toBe("");
    expect(fs.readFileSync(input, "utf-8")).toBe(src);
  }, TIMEOUT);
});

describe("wrapper text constraints", () => {
  it("keeps the base CLI invocation, the --unsafe and exit 0 substrings, and does no errno classification", () => {
    const text = fs.readFileSync(WRAPPER, "utf-8");
    expect(text).toContain("--unsafe");
    expect(text).toContain("exit 0");
    expect(text).toMatch(/timeout 60 npx --prefix "\$PROJECT_DIR" tsx "\$PROJECT_DIR\/src\/index\.ts" --unsafe "\$INPUT" "\$OUTPUT" 2>\/dev\/null/);
    expect(text).toMatch(/-ef/);
    expect(text).not.toMatch(/\b(ENOENT|EACCES|EEXIST|ENOTDIR|EISDIR|ELOOP|ENOSPC|EIO|EPERM|EROFS)\b/);
    expect(text).not.toMatch(/errno/i);
  });
});
