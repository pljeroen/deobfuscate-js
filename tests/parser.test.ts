import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";

describe("parser", () => {
  describe("parse", () => {
    it("parses simple variable declaration", () => {
      const ast = parse("var x = 1;");
      expect(ast.type).toBe("File");
      expect(ast.program.body.length).toBe(1);
      expect(ast.program.body[0].type).toBe("VariableDeclaration");
    });

    it("parses function declaration", () => {
      const ast = parse("function foo(a, b) { return a + b; }");
      expect(ast.program.body[0].type).toBe("FunctionDeclaration");
    });

    it("parses arrow function", () => {
      const ast = parse("const f = (x) => x + 1;");
      expect(ast.program.body[0].type).toBe("VariableDeclaration");
    });

    it("handles minified code without newlines", () => {
      const ast = parse("var a=1;var b=2;function f(n){return n+1}");
      expect(ast.program.body.length).toBe(3);
    });

    it("parses real minified lodash snippet", () => {
      const snippet = 'var n=function(n,t){return n+t},t="string";';
      const ast = parse(snippet);
      expect(ast.program.body.length).toBeGreaterThan(0);
    });
  });

  describe("generate", () => {
    it("round-trips simple code", () => {
      const source = "var x = 1;";
      const ast = parse(source);
      const output = generate(ast);
      expect(output).toContain("var x = 1");
    });

    it("round-trips function", () => {
      const ast = parse("function foo(a, b) { return a + b; }");
      const output = generate(ast);
      expect(output).toContain("function foo");
      expect(output).toContain("return a + b");
    });

    it("preserves semantics through round-trip", () => {
      const source = "var a = !0, b = !1;";
      const ast = parse(source);
      const output = generate(ast);
      // Should contain the same constructs (Babel may normalize whitespace)
      expect(output).toContain("!0");
      expect(output).toContain("!1");
    });
  });
});
