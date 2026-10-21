/**
 * Regression tests for the findings from the FORMAT-01 adversarial review.
 * Resource pressure is isolated in child processes so an abort is reported as
 * a normal assertion failure and cannot terminate the Vitest worker.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { formatPass } from "../src/passes/format.js";
import type { TokenPassResult } from "../src/types.js";
import { referenceSame } from "./format-same-reference.js";

const ROOT = resolve(import.meta.dirname, "..");
const HEAP_MIB = 48;
const ENTRY_COUNT = 5_000;
const CHILD_TIMEOUT_MS = 10_000;

interface ChildPayload {
  mode: "layout" | "checked";
  inputBytes: number;
  outputBytes: number;
  outputSha256: string;
  exactExpected: boolean;
  valid: boolean;
  fallbackReason: string | null;
}

function childProgram(mode: ChildPayload["mode"]): string {
  return `
    const { createHash } = await import("node:crypto");
    const { parse } = await import("@babel/parser");
    const { formatPass } = await import("./src/passes/format.ts");
    const count = ${ENTRY_COUNT};
    const entries = Array.from(
      { length: count },
      (_, index) => "{id:" + index + ",value:\\"v" + index + "\\"}",
    );
    const source = "const values=[" + entries.join(",") + "];void values;";
    const expectedEntries = Array.from(
      { length: count },
      (_, index) => "{\\n  id: " + index + ", value: \\\"v" + index + "\\\"\\n}",
    );
    const expected = "const values = [ " + expectedEntries.join(", ") + "\\n];\\nvoid values;\\n";
    const mode = ${JSON.stringify(mode)};
    const result = mode === "layout"
      ? { text: formatPass.layout(source) }
      : formatPass.runWithResult(source);
    globalThis.gc?.();
    parse(result.text, { sourceType: "script", errorRecovery: false });
    process.stdout.write(JSON.stringify({
      mode,
      inputBytes: Buffer.byteLength(source),
      outputBytes: Buffer.byteLength(result.text),
      outputSha256: createHash("sha256").update(result.text).digest("hex"),
      exactExpected: result.text === expected,
      valid: true,
      fallbackReason: result.fallbackReason ?? null,
    }));
  `;
}

function runConstrained(mode: ChildPayload["mode"]) {
  return spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${HEAP_MIB}`,
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      childProgram(mode),
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function exitDescription(run: ReturnType<typeof runConstrained>): string {
  if (run.error !== undefined) return `spawn error: ${run.error.message}`;
  if (run.signal !== null) return `signal ${run.signal}`;
  return `exit ${String(run.status)}`;
}

function payload(run: ReturnType<typeof runConstrained>): ChildPayload {
  return JSON.parse(run.stdout) as ChildPayload;
}

describe("FORMAT-01 adversarial-review regressions", () => {
  it("F-A10-01: the checked path fits wherever the unchecked layout plus validity check fits", () => {
    const baseline = runConstrained("layout");
    expect(exitDescription(baseline), baseline.stderr).toBe("exit 0");
    const unchecked = payload(baseline);
    expect(unchecked).toMatchObject({
      mode: "layout",
      inputBytes: 117_807,
      outputBytes: 157_812,
      exactExpected: true,
      valid: true,
      fallbackReason: null,
    });

    const checkedRun = runConstrained("checked");
    expect(exitDescription(checkedRun), checkedRun.stderr).toBe("exit 0");
    const checked = payload(checkedRun);
    expect(checked).toMatchObject({
      mode: "checked",
      inputBytes: unchecked.inputBytes,
      outputBytes: unchecked.outputBytes,
      exactExpected: true,
      valid: true,
      fallbackReason: null,
    });
    expect(checked.outputSha256).toBe(unchecked.outputSha256);
    expect(checked.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 15_000);

  it("F-A10-03: a delegating replacement of run does not recurse through runWithResult", () => {
    const input = "var answer=1;";
    const originalRun = formatPass.run;
    formatPass.run = (text: string): string => originalRun(text);
    let result: TokenPassResult | undefined;
    let thrown: unknown;
    try {
      try {
        result = formatPass.runWithResult(input);
      } catch (error: unknown) {
        thrown = error;
      }
    } finally {
      formatPass.run = originalRun;
    }

    expect(thrown).toBeUndefined();
    expect(result).toEqual({ text: "var answer = 1;\n" });
  });

  it("F-A10-05: a keyword-named property has exactly one separator before a binary operator", () => {
    const input = "var obj={of:4};obj.of/2;";
    const result = formatPass.runWithResult(input);

    expect(result).toEqual({ text: "var obj = {\n  of: 4\n};\nobj.of / 2;\n" });
    expect(result.text).not.toContain("obj.of  / 2");
    expect(referenceSame(input, result.text)).toMatchObject({ same: true });
  });
});
