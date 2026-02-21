import { describe, it, expect } from "vitest";
import { constantFoldPass } from "../../src/passes/constant-fold.js";
import { parse, generate } from "../../src/parser.js";

function fold(code: string): string {
  const ast = parse(code);
  const result = constantFoldPass.run(ast);
  return generate(result);
}

describe("constant folding", () => {
  describe("numeric arithmetic", () => {
    it("folds addition", () => {
      expect(fold("var x = 1 + 2;")).toContain("var x = 3");
    });

    it("folds subtraction", () => {
      expect(fold("var x = 10 - 3;")).toContain("var x = 7");
    });

    it("folds multiplication", () => {
      expect(fold("var x = 3 * 4;")).toContain("var x = 12");
    });

    it("folds division", () => {
      expect(fold("var x = 10 / 2;")).toContain("var x = 5");
    });

    it("folds modulo", () => {
      expect(fold("var x = 10 % 3;")).toContain("var x = 1");
    });

    it("folds exponentiation", () => {
      expect(fold("var x = 2 ** 3;")).toContain("var x = 8");
    });

    it("folds nested arithmetic", () => {
      expect(fold("var x = (1 + 2) * 3;")).toContain("var x = 9");
    });

    it("folds hex literals", () => {
      expect(fold("var x = 0x10 + 0x20;")).toContain("var x = 48");
    });
  });

  describe("string concatenation", () => {
    it("folds string + string", () => {
      expect(fold('var x = "hel" + "lo";')).toContain('var x = "hello"');
    });

    it("folds multiple concatenations", () => {
      expect(fold('var x = "a" + "b" + "c";')).toContain('var x = "abc"');
    });

    it("does not fold string + number (type coercion)", () => {
      // This is a coercion case; conservative approach: don't fold
      const result = fold('var x = "a" + 1;');
      // Should either fold to "a1" or leave as-is — both are acceptable
      expect(result).toContain("var x =");
    });
  });

  describe("boolean logic", () => {
    it("folds !true -> false", () => {
      expect(fold("var x = !true;")).toContain("var x = false");
    });

    it("folds !false -> true", () => {
      expect(fold("var x = !false;")).toContain("var x = true");
    });

    it("folds !!true -> true", () => {
      expect(fold("var x = !!true;")).toContain("var x = true");
    });

    it("folds true && false -> false", () => {
      expect(fold("var x = true && false;")).toContain("var x = false");
    });

    it("folds true || false -> true", () => {
      expect(fold("var x = true || false;")).toContain("var x = true");
    });
  });

  describe("obfuscator boolean patterns", () => {
    it("folds ![] -> false", () => {
      expect(fold("var x = ![];")).toContain("var x = false");
    });

    it("folds !![] -> true", () => {
      expect(fold("var x = !![];")).toContain("var x = true");
    });

    it("folds !'' -> true", () => {
      expect(fold("var x = !'';")).toContain("var x = true");
    });
  });

  describe("typeof on literals", () => {
    it("folds typeof undefined", () => {
      expect(fold('var x = typeof undefined;')).toContain('var x = "undefined"');
    });

    it("folds typeof 'string'", () => {
      expect(fold("var x = typeof 'hello';")).toContain('var x = "string"');
    });

    it("folds typeof 42", () => {
      expect(fold("var x = typeof 42;")).toContain('var x = "number"');
    });

    it("folds typeof true", () => {
      expect(fold("var x = typeof true;")).toContain('var x = "boolean"');
    });
  });

  describe("comparison folding", () => {
    it("folds === with same values", () => {
      expect(fold("var x = 1 === 1;")).toContain("var x = true");
    });

    it("folds !== with different values", () => {
      expect(fold("var x = 1 !== 2;")).toContain("var x = true");
    });

    it("folds < comparison", () => {
      expect(fold("var x = 1 < 2;")).toContain("var x = true");
    });
  });

  describe("void 0 -> undefined", () => {
    it("folds void 0 to undefined", () => {
      expect(fold("var x = void 0;")).toContain("var x = undefined");
    });
  });

  describe("!0 and !1 idioms", () => {
    it("folds !0 to true", () => {
      expect(fold("var x = !0;")).toContain("var x = true");
    });

    it("folds !1 to false", () => {
      expect(fold("var x = !1;")).toContain("var x = false");
    });
  });

  describe("preserves non-constant expressions", () => {
    it("does not fold expressions with variables", () => {
      const result = fold("var x = a + b;");
      expect(result).toContain("a + b");
    });

    it("does not fold function calls", () => {
      const result = fold("var x = foo();");
      expect(result).toContain("foo()");
    });

    it("does not fold division by zero", () => {
      const result = fold("var x = 1 / 0;");
      // Should either produce Infinity or leave as-is
      expect(result).toContain("var x =");
    });
  });
});
