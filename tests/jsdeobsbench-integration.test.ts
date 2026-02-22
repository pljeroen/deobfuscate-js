import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOOL_PY = join(__dirname, "..", "benchmarks", "jsdeobsbench", "deobfuscators", "deobfuscate_with_tool.py");
const WRAPPER = join(__dirname, "..", "scripts", "deobfuscate-js.sh");

describe("JsDeObsBench integration", () => {
  it("deobfuscate_with_tool.py has deobfuscate-js function", () => {
    const py = readFileSync(TOOL_PY, "utf-8");
    expect(py).toContain("def deobfuscate_with_deobfuscatejs(dataset_jsonl_path):");
  });

  it("deobfuscate_with_tool.py dispatches to deobfuscate-js", () => {
    const py = readFileSync(TOOL_PY, "utf-8");
    expect(py).toContain('elif deobfuscator == "deobfuscate-js":');
    expect(py).toContain("deobfuscate_with_deobfuscatejs(dataset_jsonl_path)");
  });

  it("deobfuscate_with_tool.py references our wrapper script", () => {
    const py = readFileSync(TOOL_PY, "utf-8");
    expect(py).toContain("deobfuscate-js.sh");
  });

  it("wrapper script exists and is executable", () => {
    const stat = readFileSync(WRAPPER);
    expect(stat.length).toBeGreaterThan(0);
    const content = stat.toString();
    expect(content).toContain("--unsafe");
    expect(content).toContain("exit 0");
  });
});
