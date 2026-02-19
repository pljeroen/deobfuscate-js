import { describe, it, expect } from "vitest";
import { astRenamePass } from "../../src/passes/ast-rename.js";
import { parse, generate } from "../../src/parser.js";

function rename(code: string): string {
  const ast = parse(code);
  const result = astRenamePass.run(ast);
  return generate(result);
}

describe("AST rename pass", () => {
  describe("function parameters", () => {
    it("renames single-letter params to descriptive names", () => {
      const result = rename("function f(n, t) { return n + t; }");
      expect(result).not.toContain("(n,");
      expect(result).not.toContain("(n ");
      // Should use descriptive names
      expect(result).toMatch(/function f\(\w{2,}/);
    });

    it("preserves conventional names (i, j, k)", () => {
      const result = rename("function f(i, j) { return i + j; }");
      expect(result).toContain("(i,");
      expect(result).toContain("j)");
    });

    it("preserves $ and _ names", () => {
      const result = rename("function f($, _) { return $ + _; }");
      expect(result).toContain("$");
      expect(result).toContain("_");
    });

    it("does not rename long names", () => {
      const result = rename("function f(name, value) { return name + value; }");
      expect(result).toContain("name");
      expect(result).toContain("value");
    });
  });

  describe("local variables", () => {
    it("renames single-letter var declarations", () => {
      const result = rename("function f() { var n = 1; return n; }");
      expect(result).not.toMatch(/var n\b/);
    });

    it("renames single-letter let/const", () => {
      const result = rename("function f() { const n = 1; let t = 2; return n + t; }");
      expect(result).not.toMatch(/const n\b/);
      expect(result).not.toMatch(/let t\b/);
    });
  });

  describe("scope isolation", () => {
    it("renames independently per function", () => {
      const result = rename("function f(n) { return n; } function g(n) { return n; }");
      // Both functions' n should be renamed (possibly to same or different names)
      expect(result).not.toMatch(/\(n\)/);
    });

    it("handles nested scopes", () => {
      const result = rename("function f(n) { function g(t) { return t; } return n; }");
      expect(result).not.toMatch(/\(n\)/);
      expect(result).not.toMatch(/\(t\)/);
    });
  });

  describe("preserves structure", () => {
    it("does not rename property access", () => {
      const result = rename("function f(n) { return n.x; }");
      expect(result).toContain(".x");
    });

    it("does not rename object keys", () => {
      const result = rename("function f(n) { return {a: n}; }");
      expect(result).toContain("a:");
    });

    it("does not rename globals", () => {
      const result = rename("function f() { return Math.max(1, 2); }");
      expect(result).toContain("Math");
    });
  });

  describe("arrow functions", () => {
    it("renames arrow function params", () => {
      const result = rename("const f = (n, t) => n + t;");
      expect(result).not.toMatch(/\(n,/);
    });
  });

  describe("two-letter variables", () => {
    it("renames two-letter minified names", () => {
      const result = rename("function f(nn, tt) { return nn + tt; }");
      expect(result).not.toMatch(/\(nn,/);
    });
  });
});
