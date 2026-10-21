/**
 * The format pass's fallback through the in-process benchmark runner
 * scripts/bench-batch.ts (FORMAT-01 R-FM-11, UX-FM-02 criterion 6), run as a
 * subprocess: a record whose AST-phase code is not a program prints exactly
 * one "Warning on <filename>: format: output left unformatted: <reason>" line
 * and is not counted as a failure.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PIPELINE_FALLBACK_PREFIX, REASON_NOT_PROGRAM, RECOVERED_ERROR_INPUTS } from "./format-same-reference.js";
import { TempDirs } from "./temp-dirs.js";

const ROOT = resolve(import.meta.dirname, "..");
const BATCH = join(ROOT, "scripts", "bench-batch.ts");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

const temps = new TempDirs();
afterAll(() => temps.removeAll());

describe("scripts/bench-batch.ts (UX-FM-02)", () => {
  it("--unsafe, one record that is not a program: one format warning line for its filename, 0 failures", () => {
    const dir = temps.make("format01-batch-");
    const input = join(dir, "in.jsonl");
    const output = join(dir, "out.jsonl");
    const filename = "trigger1.js";
    fs.writeFileSync(input, `${JSON.stringify({ filename, obfuscated: RECOVERED_ERROR_INPUTS[0] })}\n`);

    const r = spawnSync(process.execPath, ["--import", TSX_LOADER, BATCH, input, output, "--unsafe"], {
      cwd: ROOT,
      env: { ...process.env },
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = ((r.stderr as Buffer | null) ?? Buffer.alloc(0)).toString("utf-8").split("\n");
    expect(r.status, stderr.join("\n")).toBe(0);
    expect(stderr.filter((l) => l.startsWith(`Warning on ${filename}: format: `))).toEqual([`Warning on ${filename}: ${PIPELINE_FALLBACK_PREFIX}${REASON_NOT_PROGRAM}`]);
    expect(stderr.filter((l) => /^Done: .*\b0 failures\b/.test(l))).toHaveLength(1);
  }, 120000);
});
