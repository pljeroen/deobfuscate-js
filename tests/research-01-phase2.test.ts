/**
 * RESEARCH-01 Phase 2: Analysis Improvements
 * M1: Static string array recovery (safe mode fallback)
 * M2: Type-informed semantic renaming
 */
import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";
import type { ASTPass } from "../src/types.js";

// === M1: Static string array recovery ===

describe("M1: static string array recovery (safe mode)", () => {
  it("resolves unencoded string arrays by direct index lookup", async () => {
    const { stringArrayStaticPass } = await import("../src/passes/string-array-static.js");
    const code = `
      var _0xabc = ["hello", "world", "foo", "bar"];
      function _0xdec(idx) { return _0xabc[idx]; }
      var x = _0xdec(0);
      var y = _0xdec(1);
    `;
    const ast = parse(code);
    const result = stringArrayStaticPass.run(ast, code);
    const output = generate(result);
    expect(output).toContain('"hello"');
    expect(output).toContain('"world"');
  });

  it("resolves string arrays with numeric offset", async () => {
    const { stringArrayStaticPass } = await import("../src/passes/string-array-static.js");
    const code = `
      var _0xabc = ["hello", "world", "foo", "bar"];
      function _0xdec(idx) { return _0xabc[idx - 100]; }
      var x = _0xdec(100);
      var y = _0xdec(101);
    `;
    const ast = parse(code);
    const result = stringArrayStaticPass.run(ast, code);
    const output = generate(result);
    expect(output).toContain('"hello"');
    expect(output).toContain('"world"');
  });

  it("is marked as safe — no code execution", async () => {
    const { stringArrayStaticPass } = await import("../src/passes/string-array-static.js");
    expect(stringArrayStaticPass.safety).toBeUndefined(); // safe by default
  });

  it("returns AST unchanged when no string array pattern found", async () => {
    const { stringArrayStaticPass } = await import("../src/passes/string-array-static.js");
    const code = "var x = 1; var y = 2;";
    const ast = parse(code);
    const before = generate(ast);
    const result = stringArrayStaticPass.run(ast, code);
    const after = generate(result);
    expect(after).toBe(before);
  });

  it("handles base64-encoded string arrays via known-plaintext matching", async () => {
    const { stringArrayStaticPass } = await import("../src/passes/string-array-static.js");
    // Base64-encoded: "prototype" = "cHJvdG90eXBl", "constructor" = "Y29uc3RydWN0b3I="
    const code = `
      var _0xabc = ["cHJvdG90eXBl", "Y29uc3RydWN0b3I=", "bGVuZ3Ro"];
      function _0xdec(idx) { return _0xabc[idx]; }
      var x = _0xdec(0);
      var y = _0xdec(1);
      var z = _0xdec(2);
    `;
    const ast = parse(code);
    const result = stringArrayStaticPass.run(ast, code);
    const output = generate(result);
    // Should detect base64 encoding and decode
    expect(output).toContain('"prototype"');
    expect(output).toContain('"constructor"');
    expect(output).toContain('"length"');
  });

  it("removes resolved setup code (array + decoder)", async () => {
    const { stringArrayStaticPass } = await import("../src/passes/string-array-static.js");
    const code = `
      var _0xabc = ["hello", "world", "foo"];
      function _0xdec(idx) { return _0xabc[idx]; }
      var x = _0xdec(0);
      console.log(x);
    `;
    const ast = parse(code);
    const result = stringArrayStaticPass.run(ast, code);
    const output = generate(result);
    expect(output).toContain('"hello"');
    expect(output).not.toContain("_0xabc");
    expect(output).not.toContain("_0xdec");
  });
});

// === M2: Type-informed semantic renaming ===

describe("M2: type-informed semantic renaming", () => {
  it("renames variable used with array methods to arr/items", async () => {
    const { semanticRenamePass } = await import("../src/passes/semantic-rename.js");
    const code = `
      var _0x1a2b = [1, 2, 3];
      _0x1a2b.push(4);
      _0x1a2b.forEach(function(x) { console.log(x); });
    `;
    const ast = parse(code);
    const result = semanticRenamePass.run(ast, code);
    const output = generate(result);
    // Should be renamed to something array-like
    expect(output).not.toContain("_0x1a2b");
    expect(output).toMatch(/\b(arr|items|list)\b/);
  });

  it("renames variable assigned from JSON.parse to jsonData or similar", async () => {
    const { semanticRenamePass } = await import("../src/passes/semantic-rename.js");
    const code = `
      var _0x1a2b = JSON.parse(input);
      console.log(_0x1a2b);
    `;
    const ast = parse(code);
    const result = semanticRenamePass.run(ast, code);
    const output = generate(result);
    expect(output).not.toContain("_0x1a2b");
    expect(output).toMatch(/\b(data|parsed|json)\b/i);
  });

  it("renames variable used with regex methods to pattern/regex", async () => {
    const { semanticRenamePass } = await import("../src/passes/semantic-rename.js");
    const code = `
      var _0x1a2b = /test/;
      var _0x3c4d = _0x1a2b.test("hello");
      var _0x5e6f = "hello".match(_0x1a2b);
    `;
    const ast = parse(code);
    const result = semanticRenamePass.run(ast, code);
    const output = generate(result);
    expect(output).not.toContain("_0x1a2b");
    expect(output).toMatch(/\b(pattern|regex|regexp)\b/i);
  });

  it("renames variable used exclusively in arithmetic to num/value", async () => {
    const { semanticRenamePass } = await import("../src/passes/semantic-rename.js");
    const code = `
      var _0x1a2b = 0;
      _0x1a2b = _0x1a2b + 1;
      _0x1a2b = _0x1a2b * 2;
      var _0x3c4d = _0x1a2b - 5;
    `;
    const ast = parse(code);
    const result = semanticRenamePass.run(ast, code);
    const output = generate(result);
    // The for-loop pattern already handles i/j/k; this tests non-loop arithmetic
    // Should NOT rename since _0x1a2b starts at 0 and increments — could be a counter
    // But with reassignment via = and *, it's a general numeric variable
    expect(output).not.toContain("_0x1a2b");
  });

  it("renames callback parameter in addEventListener to handler", async () => {
    const { semanticRenamePass } = await import("../src/passes/semantic-rename.js");
    const code = `
      document.addEventListener("click", function _0x1a2b(_0x3c4d) {
        console.log(_0x3c4d.target);
      });
    `;
    const ast = parse(code);
    const result = semanticRenamePass.run(ast, code);
    const output = generate(result);
    // Event parameter should be named event/evt
    expect(output).not.toContain("_0x3c4d");
    expect(output).toMatch(/\b(event|evt)\b/);
  });

  it("preserves existing loop/length/error patterns", async () => {
    const { semanticRenamePass } = await import("../src/passes/semantic-rename.js");
    const code = `
      for (var _0x1a2b = 0; _0x1a2b < 10; _0x1a2b++) {
        console.log(_0x1a2b);
      }
      var _0x3c4d = arr.length;
    `;
    const ast = parse(code);
    const result = semanticRenamePass.run(ast, code);
    const output = generate(result);
    expect(output).toContain(" i ");
    expect(output).toContain("len");
  });
});
