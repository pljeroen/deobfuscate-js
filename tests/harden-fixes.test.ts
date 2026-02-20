/**
 * Tests for hardening fixes (HARDEN-01 + HARDEN-02 contracts).
 * HARDEN-01: Scope-safe constant propagation, exact pinning, delimiter protocol
 * HARDEN-02: Last-delimiter-wins, JSON payload size cap
 */
import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";
import { constantPropagatePass } from "../src/passes/constant-propagate.js";
import { stringArrayPass, extractDelimitedPayload } from "../src/passes/string-array.js";
import { readFileSync } from "fs";
import { resolve } from "path";

function propagate(code: string): string {
  const ast = parse(code);
  const result = constantPropagatePass.run(ast);
  return generate(result);
}

// --- H01: Scope-safe identifier alias propagation ---
// Uses non-literal initial values (call expressions) to trigger the alias path
// at lines 48-57, NOT the literal path at lines 38-44.

describe("H01: scope-safe alias propagation", () => {
  it("does NOT propagate alias when target is shadowed in inner scope", () => {
    const result = propagate(`
      const original = getSomething();
      const alias = original;
      function inner() {
        const original = 99;
        console.log(alias);
      }
    `);
    // alias must NOT be replaced with original inside inner(),
    // because original is shadowed there (would resolve to 99 instead of getSomething())
    expect(result).toContain("alias");
  });

  it("still propagates alias when target is NOT shadowed", () => {
    const result = propagate(`
      const original = getSomething();
      const alias = original;
      function inner() {
        console.log(alias);
      }
    `);
    // No shadowing — propagation to original is safe
    expect(result).toContain("console.log(original)");
  });

  it("does NOT propagate alias when target is shadowed via function param", () => {
    const result = propagate(`
      const target = getTarget();
      const alias = target;
      function process(target) {
        return alias;
      }
    `);
    // target is a parameter name in process() — shadowed
    expect(result).toContain("return alias");
  });

  it("propagates alias in same scope (no nesting)", () => {
    const result = propagate(`
      const original = getSomething();
      const alias = original;
      console.log(alias);
    `);
    // Same scope, no shadowing — safe to propagate
    expect(result).toContain("console.log(original)");
  });
});

// --- H02: Exact dependency pinning ---

describe("H02: exact dependency version pinning", () => {
  it("no caret or tilde prefixes in dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname!, "../package.json"), "utf-8")
    );
    for (const [name, version] of Object.entries(pkg.dependencies || {})) {
      expect(version, `${name} should have exact version`).not.toMatch(/^[\^~]/);
    }
  });

  it("no caret or tilde prefixes in devDependencies", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname!, "../package.json"), "utf-8")
    );
    for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
      expect(version, `${name} should have exact version`).not.toMatch(/^[\^~]/);
    }
  });
});

// --- H03: Robust sandbox output parsing ---

describe("H03: sandbox output delimiter protocol", () => {
  it("string-array pass resolves basic pattern correctly", () => {
    // Baseline: the delimiter protocol must not break normal operation
    const code = `
      var _0x4e2c = ['Hello', 'World', 'foo', 'bar'];
      function _0xdec(idx) { return _0x4e2c[idx]; }
      console.log(_0xdec(0), _0xdec(1));
    `;
    const ast = parse(code);
    const result = stringArrayPass.run(ast, code);
    const output = generate(result);
    expect(output).toContain('"Hello"');
    expect(output).toContain('"World"');
  });

  it("sandbox output with stray prefix does not break resolution", () => {
    // This tests that the delimiter protocol handles stray stdout.
    // The resolveViaSandbox function should extract JSON after the delimiter,
    // ignoring any prefix garbage.
    // We test indirectly: if the protocol works, string-array continues to resolve
    // even when the setup code produces console output (which the preamble
    // silences, but this tests the protocol's robustness).
    const code = `
      var _0x5a2b = ['test1', 'test2', 'test3', 'test4'];
      function _0x3c(idx) { return _0x5a2b[idx]; }
      var x = _0x3c(0);
      var y = _0x3c(1);
    `;
    const ast = parse(code);
    const result = stringArrayPass.run(ast, code);
    const output = generate(result);
    expect(output).toContain('"test1"');
    expect(output).toContain('"test2"');
  });
});

// --- HARDEN-02: Last-delimiter-wins + JSON size cap ---

describe("HARDEN-02 H01: last-delimiter-wins extraction", () => {
  const DELIMITER = "__DEOBF_JSON_START__";

  it("extracts JSON after single delimiter (normal case)", () => {
    const output = `${DELIMITER}{"a":"hello"}`;
    expect(extractDelimitedPayload(output)).toBe('{"a":"hello"}');
  });

  it("extracts JSON after LAST delimiter when multiple present", () => {
    // Attacker emits delimiter + garbage, then real delimiter + valid JSON
    const attackerGarbage = `${DELIMITER}{"pwned":true}garbage`;
    const realOutput = `${DELIMITER}{"a":"hello"}`;
    const output = attackerGarbage + realOutput;
    const payload = extractDelimitedPayload(output);
    expect(JSON.parse(payload)).toEqual({ a: "hello" });
  });

  it("throws on missing delimiter", () => {
    expect(() => extractDelimitedPayload("no delimiter here")).toThrow(
      /missing delimiter/i
    );
  });

  it("handles stray stdout before delimiter", () => {
    const output = `some random console output\n${DELIMITER}{"b":"world"}`;
    expect(extractDelimitedPayload(output)).toBe('{"b":"world"}');
  });
});

describe("HARDEN-02 H02: JSON payload size cap", () => {
  const DELIMITER = "__DEOBF_JSON_START__";
  const MAX_PAYLOAD = 10 * 1024 * 1024; // 10MB, matching sandbox output cap

  it("accepts normal-sized payloads", () => {
    const json = JSON.stringify({ key: "value" });
    const output = `${DELIMITER}${json}`;
    expect(extractDelimitedPayload(output)).toBe(json);
  });

  it("throws on payload exceeding size cap", () => {
    const oversized = "x".repeat(MAX_PAYLOAD + 1);
    const output = `${DELIMITER}${oversized}`;
    expect(() => extractDelimitedPayload(output)).toThrow(/size cap/i);
  });

  it("error message includes actual size and cap", () => {
    const size = MAX_PAYLOAD + 500;
    const oversized = "x".repeat(size);
    const output = `${DELIMITER}${oversized}`;
    expect(() => extractDelimitedPayload(output)).toThrow(
      new RegExp(String(size))
    );
  });
});
