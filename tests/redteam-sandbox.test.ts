/**
 * HARDEN-03: Red-team fixtures for sandbox hardening.
 * End-to-end through stringArrayPass.run() — not raw executeSandboxed.
 *
 * Proves:
 * 1. Infinite loop in setup code times out cleanly (no hang)
 * 2. Output flood triggers cap cleanly (no OOM)
 * 3. Delimiter spoofing can't trick extraction (lastIndexOf protection)
 */
import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";
import { stringArrayPass } from "../src/passes/string-array.js";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Build a string-array pattern where the setup code contains adversarial content.
 * The decoder is a simple index lookup so the pattern is detected.
 * The adversarial code is injected into the rotation IIFE position.
 */
function buildAdversarialCode(adversarialSetup: string): string {
  return `
    var _0xabc = ['correct_a', 'correct_b', 'correct_c', 'correct_d'];
    ${adversarialSetup}
    function _0xdec(idx) { return _0xabc[idx]; }
    var x = _0xdec(0);
    var y = _0xdec(1);
  `;
}

describe("HARDEN-03 H02: red-team sandbox fixtures", () => {
  it("infinite loop in setup code times out — pass skips cleanly", () => {
    // Setup code contains an infinite loop. The sandbox should timeout
    // and the pass should catch the error and return AST unchanged.
    const code = buildAdversarialCode("while(true) {}");
    const ast = parse(code);
    const before = generate(ast);

    // This must complete (not hang). The pass catches the timeout error.
    const result = stringArrayPass.run(ast, code);
    const after = generate(result);

    // AST should be returned (pass skipped due to timeout)
    expect(after).toBeDefined();
    expect(after.length).toBeGreaterThan(0);
  }, 30000);

  it("output flood triggers cap — pass handles without OOM", () => {
    // Setup code floods stdout with data before the delimiter.
    // The output cap in the sandbox should trigger, throwing an error.
    // The pass should catch it and return AST unchanged.
    const flood = `
      var chunk = "A".repeat(1024 * 1024);
      for (var i = 0; i < 20; i++) { process.stdout.write(chunk); }
    `;
    const code = buildAdversarialCode(flood);
    const ast = parse(code);

    // Must complete without OOM
    const result = stringArrayPass.run(ast, code);
    const after = generate(result);

    expect(after).toBeDefined();
    expect(after.length).toBeGreaterThan(0);
  }, 30000);

  it("delimiter spoofing cannot trick extraction", () => {
    // Setup code emits a fake delimiter with attacker-controlled JSON.
    // The real delimiter is emitted by the sandbox script after setup.
    // lastIndexOf ensures we parse the REAL (last) delimiter's payload.
    const spoof = `
      process.stdout.write("__DEOBF_JSON_START__" + JSON.stringify({"_0xdec:0": "PWNED", "_0xdec:1": "PWNED"}));
    `;
    const code = buildAdversarialCode(spoof);
    const ast = parse(code);
    const result = stringArrayPass.run(ast, code);
    const after = generate(result);

    // The pass should have resolved using the REAL decoder results,
    // not the attacker's spoofed payload. The real values are 'correct_a'
    // and 'correct_b' from the array — these are the inlined literals.
    expect(after).toContain('"correct_a"');
    expect(after).toContain('"correct_b"');
    // Verify the resolved values are NOT the attacker's "PWNED" string.
    // The spoofing code itself remains as a statement, but the decoded
    // call sites must resolve to the real array values.
    expect(after).toMatch(/var x = "correct_a"/);
    expect(after).toMatch(/var y = "correct_b"/);
  }, 30000);
});

// --- H01: Node engines field ---

describe("HARDEN-03 H01: Node engines field", () => {
  it("package.json declares engines.node", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname!, "../package.json"), "utf-8")
    );
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.node).toBeDefined();
    expect(pkg.engines.node).toMatch(/>=\s*22/);
  });
});
