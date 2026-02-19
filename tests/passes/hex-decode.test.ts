import { describe, it, expect } from "vitest";
import { hexDecodePass } from "../../src/passes/hex-decode.js";
import { parse, generate } from "../../src/parser.js";

function decode(code: string): string {
  const ast = parse(code);
  const result = hexDecodePass.run(ast);
  return generate(result);
}

describe("hex/unicode string decoding", () => {
  describe("hex escape sequences (\\xHH)", () => {
    it("decodes simple hex string", () => {
      const result = decode('var x = "\\x48\\x65\\x6c\\x6c\\x6f";');
      expect(result).toContain('"Hello"');
    });

    it("decodes mixed hex and plain chars", () => {
      const result = decode('var x = "\\x48ello";');
      expect(result).toContain('"Hello"');
    });

    it("decodes single hex char", () => {
      const result = decode('var x = "\\x41";');
      expect(result).toContain('"A"');
    });
  });

  describe("unicode escape sequences (\\uHHHH)", () => {
    it("decodes unicode escapes", () => {
      const result = decode('var x = "\\u0048\\u0065\\u006c\\u006c\\u006f";');
      expect(result).toContain('"Hello"');
    });

    it("decodes mixed unicode and plain", () => {
      const result = decode('var x = "\\u0048ello";');
      expect(result).toContain('"Hello"');
    });
  });

  describe("unicode code point escapes (\\u{HHHH})", () => {
    it("decodes code point escapes", () => {
      const result = decode('var x = "\\u{48}\\u{65}\\u{6c}\\u{6c}\\u{6f}";');
      expect(result).toContain('"Hello"');
    });
  });

  describe("preserves non-encoded strings", () => {
    it("leaves plain strings unchanged", () => {
      const result = decode('var x = "Hello";');
      expect(result).toContain('"Hello"');
    });

    it("preserves legitimate escape sequences", () => {
      const result = decode('var x = "line1\\nline2";');
      expect(result).toContain("\\n");
    });
  });

  describe("property access strings", () => {
    it("decodes strings used as property keys", () => {
      const result = decode('obj["\\x6c\\x6f\\x67"]("hello");');
      expect(result).toContain('["log"]');
    });
  });

  describe("single-quoted strings", () => {
    it("decodes hex in single-quoted strings", () => {
      const result = decode("var x = '\\x48\\x65\\x6c\\x6c\\x6f';");
      expect(result).toContain("Hello");
    });
  });
});
