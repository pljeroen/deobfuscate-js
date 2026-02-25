import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WRAPPER = join(__dirname, "..", "scripts", "deobfuscate-js.sh");
const PROJECT_ROOT = join(__dirname, "..");

describe("CLI wrapper for JsDeObsBench integration", () => {
  it("wrapper script exists and is executable", () => {
    expect(existsSync(WRAPPER)).toBe(true);
    const stat = execSync(`stat -c %a "${WRAPPER}"`).toString().trim();
    expect(parseInt(stat, 8) & 0o111).toBeGreaterThan(0);
  });

  it("deobfuscates simple JS and writes output file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "deobfuscate-cli-"));
    const input = join(tmp, "input.js");
    const output = join(tmp, "output.js");

    writeFileSync(input, `var a = !0; var b = !1; console.log(a, b);`);

    execSync(`bash "${WRAPPER}" "${input}" "${output}"`, { timeout: 30000 });

    expect(existsSync(output)).toBe(true);
    const result = readFileSync(output, "utf-8");
    expect(result).toContain("true");
    expect(result).toContain("false");

    unlinkSync(input);
    unlinkSync(output);
  });

  it("exits 0 and writes empty file on invalid input", () => {
    const tmp = mkdtempSync(join(tmpdir(), "deobfuscate-cli-"));
    const input = join(tmp, "nonexistent.js");
    const output = join(tmp, "output.js");

    const result = execSync(`bash "${WRAPPER}" "${input}" "${output}"; echo "EXIT:$?"`, {
      timeout: 30000,
    }).toString();

    expect(result).toContain("EXIT:0");
    expect(existsSync(output)).toBe(true);
    const content = readFileSync(output, "utf-8");
    expect(content).toBe("");

    unlinkSync(output);
  });

  it("handles obfuscated code with --unsafe flag (via wrapper)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "deobfuscate-cli-"));
    const input = join(tmp, "input.js");
    const output = join(tmp, "output.js");

    // Obfuscated-style code with _0x prefix and boolean idioms
    writeFileSync(input, `
      for (var _0x1a = 0; _0x1a < 10; _0x1a++) {
        var _0x2b = !0;
        console.log(_0x1a, _0x2b);
      }
    `);

    execSync(`bash "${WRAPPER}" "${input}" "${output}"`, { timeout: 30000 });

    expect(existsSync(output)).toBe(true);
    const code = readFileSync(output, "utf-8");
    // Constant fold: !0 -> true
    expect(code).toContain("true");
    // Semantic rename: _0x1a -> i
    expect(code).toContain("var i = 0");
    expect(code).not.toContain("_0x1a");

    unlinkSync(input);
    unlinkSync(output);
  });
});
