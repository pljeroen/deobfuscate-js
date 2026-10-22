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
const PIPELINE_ENTRY_COUNT = 4_000;
const CHILD_TIMEOUT_MS = 10_000;

const KEYWORD_PROPERTY_NAMES = ["if", "for", "while", "switch", "catch", "with"] as const;
const BINARY_CONTINUATIONS = [
  "+", "-", "*", "/", "%", "**",
  "==", "!=", "===", "!==",
  "<", ">", "<=", ">=",
  "&&", "||", "??",
  "&", "|", "^", "<<", ">>", ">>>",
  "in", "instanceof",
] as const;
const ASSIGNMENT_CONTINUATIONS = [
  "=", "+=", "-=", "*=", "/=", "%=", "**=",
  "&=", "|=", "^=", "<<=", ">>=", ">>>=", "&&=", "||=", "??=",
] as const;

interface ChildPayload {
  mode: "layout" | "checked";
  inputBytes: number;
  outputBytes: number;
  outputSha256: string;
  exactExpected: boolean;
  valid: boolean;
  fallbackReason: string | null;
}

interface PipelineChildPayload {
  mode: "detached" | "integrated";
  inputBytes: number;
  astPhaseBytes?: number;
  outputBytes: number;
  outputSha256: string;
  valid: boolean;
  fallbackReason: string | null;
  warnings: string[];
  formatReport: { name: string; changed: boolean };
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

function pipelineChildProgram(mode: PipelineChildPayload["mode"]): string {
  return `
    const { createHash } = await import("node:crypto");
    const { parse } = await import("@babel/parser");
    const { formatPass } = await import("./src/passes/format.ts");
    const { runPipelineWithReport } = await import("./src/pipeline.ts");
    const count = ${PIPELINE_ENTRY_COUNT};
    const entries = Array.from(
      { length: count },
      (_, index) => "{id:" + index + ",value:\\"v" + index + "\\"}",
    );
    const source = "const values=[" + entries.join(",") + "];void values;";
    const mode = ${JSON.stringify(mode)};
    let code;
    let astPhaseBytes;
    let fallbackReason = null;
    let warnings;
    let formatReport;
    if (mode === "detached") {
      const astPhase = runPipelineWithReport(source, [], []);
      astPhaseBytes = Buffer.byteLength(astPhase.code);
      globalThis.gc?.();
      const outcome = formatPass.runWithResult(astPhase.code);
      code = outcome.text;
      fallbackReason = outcome.fallbackReason ?? null;
      warnings = [];
      formatReport = { name: "format", changed: astPhase.code !== code };
    } else {
      const result = runPipelineWithReport(source, [], [formatPass]);
      code = result.code;
      warnings = result.warnings;
      formatReport = result.report.at(-1);
    }
    parse(code, { sourceType: "script", errorRecovery: false });
    process.stdout.write(JSON.stringify({
      mode,
      inputBytes: Buffer.byteLength(source),
      ...(astPhaseBytes === undefined ? {} : { astPhaseBytes }),
      outputBytes: Buffer.byteLength(code),
      outputSha256: createHash("sha256").update(code).digest("hex"),
      valid: true,
      fallbackReason,
      warnings,
      formatReport,
    }));
  `;
}

function runPipelineConstrained(mode: PipelineChildPayload["mode"]) {
  return spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${HEAP_MIB}`,
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      pipelineChildProgram(mode),
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

function pipelinePayload(run: ReturnType<typeof runPipelineConstrained>): PipelineChildPayload {
  return JSON.parse(run.stdout) as PipelineChildPayload;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("format pass reliability regressions", () => {
  it("checked formatting stays within the proven layout-and-parse heap envelope", () => {
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

  it("integrated formatting fits when detached formatting fits under the same heap limit", () => {
    const detachedRun = runPipelineConstrained("detached");
    expect(exitDescription(detachedRun), detachedRun.stderr).toBe("exit 0");
    const detached = pipelinePayload(detachedRun);
    expect(detached).toMatchObject({
      mode: "detached",
      inputBytes: 93_807,
      astPhaseBytes: 133_809,
      outputBytes: 125_812,
      valid: true,
      fallbackReason: null,
      warnings: [],
      formatReport: { name: "format", changed: true },
    });

    const integratedRun = runPipelineConstrained("integrated");
    expect(exitDescription(integratedRun), integratedRun.stderr).toBe("exit 0");
    const integrated = pipelinePayload(integratedRun);
    expect(integrated).toMatchObject({
      mode: "integrated",
      inputBytes: detached.inputBytes,
      outputBytes: detached.outputBytes,
      valid: true,
      fallbackReason: null,
      warnings: [],
      formatReport: { name: "format", changed: true },
    });
    expect(integrated.outputSha256).toBe(detached.outputSha256);
    expect(integrated.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 15_000);

  it("a delegating run wrapper does not recurse through runWithResult", () => {
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

  it("the of property has exactly one separator before a binary operator", () => {
    const input = "var obj={of:4};obj.of/2;";
    const result = formatPass.runWithResult(input);

    expect(result).toEqual({ text: "var obj = {\n  of: 4\n};\nobj.of / 2;\n" });
    expect(result.text).not.toContain("obj.of  / 2");
    expect(referenceSame(input, result.text)).toMatchObject({ same: true });
  });

  it.each(KEYWORD_PROPERTY_NAMES)("the %s property has one separator before every applicable operator", (name) => {
    const continuations = [
      ...([".", "?."] as const).flatMap((accessor) =>
        BINARY_CONTINUATIONS.map((operator) => ({ accessor, operator })),
      ),
      ...ASSIGNMENT_CONTINUATIONS.map((operator) => ({ accessor: "." as const, operator })),
    ];

    for (const { accessor, operator } of continuations) {
      const operatorText = operator === "in" || operator === "instanceof"
        ? ` ${operator} `
        : operator;
      const input = `var obj={${name}:4},other=2;obj${accessor}${name}${operatorText}other;other++;`;
      const result = formatPass.runWithResult(input);
      const property = `obj${accessor}${name}`;
      const separator = new RegExp(`${escapeRegExp(property)}(\\s+)${escapeRegExp(operator)}`);

      expect(result.fallbackReason, `${accessor}${name}${operator}`).toBeUndefined();
      expect(result.text, `${accessor}${name}${operator}`).toContain(property);
      expect(result.text, `${accessor}${name}${operator}`).not.toContain(`obj${accessor} ${name}`);
      expect(result.text.match(separator)?.[1], `${accessor}${name}${operator}`).toBe(" ");
      expect(referenceSame(input, result.text), `${accessor}${name}${operator}`).toMatchObject({ same: true });
      if (name === "for") {
        expect(result.text, `${accessor}${name}${operator}`).toMatch(/;\nother\+\+;\n$/);
      }
    }
  });
});
