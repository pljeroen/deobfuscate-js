import { describe, it, expect } from "vitest";
import { constantPropagatePass } from "../../src/passes/constant-propagate.js";
import { parse, generate } from "../../src/parser.js";

function propagate(code: string): string {
  const ast = parse(code);
  const result = constantPropagatePass.run(ast);
  return generate(result);
}

describe("constant propagation", () => {
  describe("single-assignment constants", () => {
    it("inlines const with number literal", () => {
      const result = propagate("const x = 5; var y = x + 1;");
      expect(result).toContain("5 + 1");
      // x declaration may or may not be removed (that's dead code elimination's job)
    });

    it("inlines const with string literal", () => {
      const result = propagate('const msg = "hello"; console.log(msg);');
      expect(result).toContain('"hello"');
    });

    it("inlines const with boolean literal", () => {
      const result = propagate("const flag = true; if (flag) {}");
      expect(result).toContain("if (true)");
    });

    it("inlines var assigned once and never reassigned", () => {
      const result = propagate("var x = 42; return x;");
      expect(result).toContain("return 42");
    });
  });

  describe("does not propagate when unsafe", () => {
    it("does not inline reassigned variables", () => {
      const result = propagate("var x = 1; x = 2; return x;");
      expect(result).toContain("return x");
    });

    it("does not inline let that could be reassigned", () => {
      const result = propagate("let x = 1; if (cond) x = 2; return x;");
      expect(result).toContain("return x");
    });

    it("does not inline object/array values", () => {
      const result = propagate("const x = [1, 2]; return x;");
      expect(result).toContain("return x");
    });

    it("does not inline function calls", () => {
      const result = propagate("const x = foo(); return x;");
      expect(result).toContain("return x");
    });

    it("does not inline when binding has multiple references and value has side effects potential", () => {
      const result = propagate("const x = obj.prop; f(x); g(x);");
      // Member expressions might have getters — don't inline
      expect(result).toContain("f(x)");
    });
  });

  describe("array mutation detection", () => {
    it("does not propagate array with element update expression (postfix)", () => {
      const result = propagate("const a = [1, 2, 3]; a[0]++; console.log(a[0]);");
      expect(result).toContain("a[0]");
      expect(result).not.toContain("console.log(1)");
    });

    it("does not propagate array with element update expression (prefix)", () => {
      const result = propagate("const a = [1, 2, 3]; --a[1]; console.log(a[1]);");
      expect(result).toContain("a[1]");
      expect(result).not.toContain("console.log(2)");
    });

    it("does not propagate array with element assignment", () => {
      const result = propagate("const a = [1, 2]; a[0] = 9; console.log(a[0]);");
      expect(result).toContain("a[0]");
    });

    it("propagates array without any mutations", () => {
      const result = propagate("const a = [10, 20]; console.log(a[0]); console.log(a[1]);");
      expect(result).toContain("console.log(10)");
      expect(result).toContain("console.log(20)");
    });
  });

  describe("scope awareness", () => {
    it("propagates within function scope", () => {
      const result = propagate("function f() { const x = 1; return x; }");
      expect(result).toContain("return 1");
    });

    it("does not propagate across function boundaries incorrectly", () => {
      const result = propagate("const x = 1; function f() { return x; }");
      // This is actually safe to propagate — x is const and in outer scope
      expect(result).toContain("return 1");
    });
  });
});
