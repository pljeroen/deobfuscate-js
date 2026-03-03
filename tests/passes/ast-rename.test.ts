import { describe, it, expect } from "vitest";
import { astRenamePass } from "../../src/passes/ast-rename.js";
import { parse, generate } from "../../src/parser.js";

function rename(code: string): string {
  const ast = parse(code);
  const result = astRenamePass.run(ast);
  return generate(result);
}

// Helper: wrap code with _0x marker to trigger the obfuscation gate
function obf(code: string): string {
  return `var _0x1234 = 1; ${code}`;
}

describe("AST rename pass", () => {
  describe("function parameters", () => {
    it("renames single-letter params to descriptive names", () => {
      const result = rename(obf("function f(n, t) { return n + t; }"));
      expect(result).not.toContain("(n,");
      expect(result).not.toContain("(n ");
      // Should use descriptive names
      expect(result).toMatch(/function f\(\w{2,}/);
    });

    it("preserves conventional names (i, j, k)", () => {
      const result = rename(obf("function f(i, j) { return i + j; }"));
      expect(result).toContain("(i,");
      expect(result).toContain("j)");
    });

    it("preserves $ and _ names", () => {
      const result = rename(obf("function f($, _) { return $ + _; }"));
      expect(result).toContain("$");
      expect(result).toContain("_");
    });

    it("does not rename long names", () => {
      const result = rename(obf("function f(name, value) { return name + value; }"));
      expect(result).toContain("name");
      expect(result).toContain("value");
    });
  });

  describe("local variables", () => {
    it("renames single-letter var declarations", () => {
      const result = rename(obf("function f() { var n = 1; return n; }"));
      expect(result).not.toMatch(/var n\b/);
    });

    it("renames single-letter let/const", () => {
      const result = rename(obf("function f() { const n = 1; let t = 2; return n + t; }"));
      expect(result).not.toMatch(/const n\b/);
      expect(result).not.toMatch(/let t\b/);
    });
  });

  describe("scope isolation", () => {
    it("renames independently per function", () => {
      const result = rename(obf("function f(n) { return n; } function g(n) { return n; }"));
      // Both functions' n should be renamed (possibly to same or different names)
      expect(result).not.toMatch(/\(n\)/);
    });

    it("handles nested scopes", () => {
      const result = rename(obf("function f(n) { function g(t) { return t; } return n; }"));
      expect(result).not.toMatch(/\(n\)/);
      expect(result).not.toMatch(/\(t\)/);
    });
  });

  describe("preserves structure", () => {
    it("does not rename property access", () => {
      const result = rename(obf("function f(n) { return n.x; }"));
      expect(result).toContain(".x");
    });

    it("does not rename object keys", () => {
      const result = rename(obf("function f(n) { return {a: n}; }"));
      expect(result).toContain("a:");
    });

    it("does not rename globals", () => {
      const result = rename(obf("function f() { return Math.max(1, 2); }"));
      expect(result).toContain("Math");
    });
  });

  describe("arrow functions", () => {
    it("renames arrow function params", () => {
      const result = rename(obf("const f = (n, t) => n + t;"));
      expect(result).not.toMatch(/\(n,/);
    });
  });

  describe("two-letter variables", () => {
    it("renames two-letter minified names", () => {
      const result = rename(obf("function f(nn, tt) { return nn + tt; }"));
      expect(result).not.toMatch(/\(nn,/);
    });
  });

  describe("obfuscation gating", () => {
    it("skips rename when no _0x identifiers exist", () => {
      const result = rename("function f(s, a, b) { return s + a + b; }");
      expect(result).toContain("(s,");
      expect(result).toContain("a,");
      expect(result).toContain("b)");
    });

    it("renames when _0x identifiers are present", () => {
      const result = rename("var _0x1234 = 1; function f(n, t) { return n + t + _0x1234; }");
      expect(result).not.toMatch(/\(n,/);
    });

    it("preserves correct short names in non-obfuscated code", () => {
      const code = "function add(a, b) { var r = a + b; return r; }";
      const result = rename(code);
      expect(result).toContain("a,");
      expect(result).toContain("b)");
      expect(result).toContain("var r");
    });
  });

  describe("_0x-prefixed identifiers", () => {
    it("renames _0x-prefixed function parameters", () => {
      const result = rename("function f(_0x1234, _0x5678) { return _0x1234 + _0x5678; }");
      expect(result).not.toContain("_0x1234");
      expect(result).not.toContain("_0x5678");
    });

    it("renames _0x-prefixed local variables", () => {
      const result = rename("function f() { var _0xabc = 1; return _0xabc; }");
      expect(result).not.toContain("_0xabc");
    });

    it("renames _0x-prefixed arrow function params", () => {
      const result = rename("const f = (_0x1a2b, _0x3c4d) => _0x1a2b + _0x3c4d;");
      expect(result).not.toContain("_0x1a2b");
      expect(result).not.toContain("_0x3c4d");
    });

    it("does not rename _0x property access", () => {
      const result = rename("function f(_0x1234) { return _0x1234._0x5678; }");
      expect(result).toContain("._0x5678");
    });

    it("renames mix of short and _0x names", () => {
      const result = rename("function f(n, _0xabc) { return n + _0xabc; }");
      expect(result).not.toContain("(n,");
      expect(result).not.toContain("_0xabc");
    });

    it("renames a0_0x prefixed identifiers", () => {
      const result = rename("function f(a0_0x1234, a0_0x5678) { return a0_0x1234 + a0_0x5678; }");
      expect(result).not.toContain("a0_0x1234");
      expect(result).not.toContain("a0_0x5678");
    });

    it("does not collide _0x renames with existing names", () => {
      const result = rename("function f(_0x1234, value) { return _0x1234 + value; }");
      // _0x1234 should be renamed but NOT to 'value'
      expect(result).not.toContain("_0x1234");
      expect(result).toMatch(/value/); // original 'value' preserved
    });
  });

  describe("descendant scope collision", () => {
    it("does not rename to a name already bound in a child block scope", () => {
      // 'value' is declared in a while-body block scope
      // _0x1234 should NOT be renamed to 'value' (first candidate)
      const result = rename(
        "function f(_0x1234) { while (true) { let value = 1; console.log(value); } return _0x1234; }"
      );
      const match = result.match(/function f\((\w+)\)/);
      expect(match).toBeTruthy();
      expect(match![1]).not.toBe("value");
      // Inner 'value' binding must be preserved
      expect(result).toContain("let value");
    });

    it("does not rename to a name already bound in a nested if-block scope", () => {
      // 'value' is in an if-block, 'other' is in the else-block
      const result = rename(
        "function f(_0x1234) { if (true) { let value = 1; } else { let other = 2; } return _0x1234; }"
      );
      const match = result.match(/function f\((\w+)\)/);
      expect(match).toBeTruthy();
      expect(match![1]).not.toBe("value");
      expect(match![1]).not.toBe("other");
    });

    it("does not rename to a name bound in a for-loop block scope", () => {
      const result = rename(
        "function f(_0x1234) { for (let value = 0; value < 10; value++) { console.log(value); } return _0x1234; }"
      );
      const match = result.match(/function f\((\w+)\)/);
      expect(match).toBeTruthy();
      expect(match![1]).not.toBe("value");
    });
  });

  describe("undeclared global collision", () => {
    it("does not rename to a name that collides with undeclared reference", () => {
      // 'value' is used as undeclared global, so should not be used as a rename target
      const result = rename("var _0x1234 = 1; function f(n) { return n + value; }");
      // n should be renamed but NOT to 'value'
      expect(result).not.toMatch(/\(value\)/);
      expect(result).toContain("value");
    });
  });
});
