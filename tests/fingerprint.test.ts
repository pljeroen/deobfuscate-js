import { describe, it, expect } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import { parse } from "../src/parser.js";

describe("R16: obfuscator fingerprinting", () => {
  it("detects javascript-obfuscator by string array + decoder pattern", () => {
    const ast = parse(`
      var _0x4e2c = ['log', 'Hello', 'world'];
      function _0xdec(idx) { return _0x4e2c[idx]; }
      console[_0xdec(0)](_0xdec(1));
    `);
    const result = fingerprint(ast);
    expect(result.obfuscator).toBe("javascript-obfuscator");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("detects javascript-obfuscator by hex identifier pattern", () => {
    const ast = parse(`
      var _0x1a2b = 1;
      var _0x3c4d = 2;
      var _0x5e6f = _0x1a2b + _0x3c4d;
      function _0xabcd(_0xef01) { return _0xef01 * 2; }
    `);
    const result = fingerprint(ast);
    expect(result.obfuscator).toBe("javascript-obfuscator");
    expect(result.patterns).toContain("hex-identifiers");
  });

  it("detects javascript-obfuscator by control flow flattening pattern", () => {
    const ast = parse(`
      var _0x = '2|0|1'.split('|');
      var _0xi = 0;
      while (!![]) {
        switch (_0x[_0xi++]) {
          case '0': console.log('a'); continue;
          case '1': console.log('b'); continue;
          case '2': console.log('c'); continue;
        }
        break;
      }
    `);
    const result = fingerprint(ast);
    expect(result.obfuscator).toBe("javascript-obfuscator");
    expect(result.patterns).toContain("control-flow-flattening");
  });

  it("returns null obfuscator for plain code", () => {
    const ast = parse(`
      function add(a, b) { return a + b; }
      console.log(add(1, 2));
    `);
    const result = fingerprint(ast);
    expect(result.obfuscator).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("returns null obfuscator for minified (not obfuscated) code", () => {
    const ast = parse(`var n=function(n,t){return n+t},t="string";console.log(n(1,2))`);
    const result = fingerprint(ast);
    expect(result.obfuscator).toBeNull();
  });

  it("returns detected patterns as array", () => {
    const ast = parse(`
      var _0x4e2c = ['log', 'Hello'];
      function _0xdec(idx) { return _0x4e2c[idx]; }
      var _0x1a2b = _0xdec(0);
    `);
    const result = fingerprint(ast);
    expect(Array.isArray(result.patterns)).toBe(true);
    expect(result.patterns.length).toBeGreaterThan(0);
  });
});
