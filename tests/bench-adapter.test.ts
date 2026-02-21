/**
 * BENCH-01: JsDeObsBench adapter tests
 * Tests the benchmark adapter that runs our pipeline against JsDeObsBench JSONL format.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ADAPTER = "npx tsx scripts/bench-jsdeobsbench.ts";
const TIMEOUT = 60000;

function tmpDir(name: string) {
  const dir = join(__dirname, "..", `.tmp-bench-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

function writeJsonl(path: string, records: object[]) {
  writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n");
}

function readJsonl(path: string): any[] {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
}

function runAdapter(input: string, output: string, extraArgs = "") {
  return execSync(`${ADAPTER} --input ${input} --output ${output} ${extraArgs}`, {
    timeout: TIMEOUT,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("BENCH-01: JsDeObsBench adapter", () => {
  it("deobfuscates JSONL records and adds deobfuscated field", () => {
    const dir = tmpDir("t1");
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "output.jsonl");
      writeJsonl(input, [
        {
          filename: "test_1",
          original: "console.log(1 + 2);",
          obfuscated: "console.log(1 + 2);",
          test_cases: [["", "3\n"]],
          language: "JavaScript",
        },
      ]);
      runAdapter(input, output);
      const results = readJsonl(output);
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty("deobfuscated");
      expect(results[0].filename).toBe("test_1");
      expect(results[0]).toHaveProperty("original");
      expect(results[0]).toHaveProperty("obfuscated");
      expect(results[0]).toHaveProperty("test_cases");
    } finally {
      cleanup(dir);
    }
  }, TIMEOUT);

  it("processes multiple records", () => {
    const dir = tmpDir("t2");
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "output.jsonl");
      writeJsonl(input, [
        { filename: "p1", original: "console.log(1);", obfuscated: "console.log(1);", test_cases: [], language: "JavaScript" },
        { filename: "p2", original: "console.log(2);", obfuscated: "console.log(2);", test_cases: [], language: "JavaScript" },
        { filename: "p3", original: "console.log(3);", obfuscated: "console.log(3);", test_cases: [], language: "JavaScript" },
      ]);
      runAdapter(input, output);
      const results = readJsonl(output);
      expect(results).toHaveLength(3);
      expect(results.map((r: any) => r.filename)).toEqual(["p1", "p2", "p3"]);
      expect(results.every((r: any) => typeof r.deobfuscated === "string")).toBe(true);
    } finally {
      cleanup(dir);
    }
  }, TIMEOUT);

  it("applies constant folding to obfuscated code", () => {
    const dir = tmpDir("t3");
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "output.jsonl");
      writeJsonl(input, [
        {
          filename: "fold_test",
          original: "console.log(3);",
          obfuscated: "console.log(1 + 2);",
          test_cases: [],
          language: "JavaScript",
        },
      ]);
      runAdapter(input, output);
      const results = readJsonl(output);
      // Constant folding should simplify 1 + 2 to 3
      expect(results[0].deobfuscated).toContain("3");
      expect(results[0].deobfuscated).not.toContain("1 + 2");
    } finally {
      cleanup(dir);
    }
  }, TIMEOUT);

  it("survives malformed JavaScript without crashing", () => {
    const dir = tmpDir("t4");
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "output.jsonl");
      writeJsonl(input, [
        { filename: "good", original: "console.log(1);", obfuscated: "console.log(1);", test_cases: [], language: "JavaScript" },
        { filename: "bad", original: "console.log(1);", obfuscated: "this is not javascript {{{{", test_cases: [], language: "JavaScript" },
        { filename: "good2", original: "console.log(2);", obfuscated: "console.log(2);", test_cases: [], language: "JavaScript" },
      ]);
      runAdapter(input, output);
      const results = readJsonl(output);
      expect(results).toHaveLength(3);
      // Good records should have non-empty deobfuscated
      expect(results[0].deobfuscated.length).toBeGreaterThan(0);
      expect(results[2].deobfuscated.length).toBeGreaterThan(0);
    } finally {
      cleanup(dir);
    }
  }, TIMEOUT);

  it("reports progress to stderr", () => {
    const dir = tmpDir("t5");
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "output.jsonl");
      writeJsonl(input, [
        { filename: "p1", original: "console.log(1);", obfuscated: "console.log(1);", test_cases: [], language: "JavaScript" },
      ]);
      runAdapter(input, output);
      const results = readJsonl(output);
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty("deobfuscated");
    } finally {
      cleanup(dir);
    }
  }, TIMEOUT);
});
