import { describe, it, expect } from "vitest";
import { astSimplifyPass } from "../../src/passes/ast-simplify.js";
import { parse, generate } from "../../src/parser.js";

function simplify(code: string): string {
  const ast = parse(code);
  const result = astSimplifyPass.run(ast);
  return generate(result);
}

describe("AST simplify pass", () => {
  describe("comma expression splitting", () => {
    it("splits top-level comma expressions into separate statements", () => {
      const result = simplify("a = 1, b = 2, c = 3;");
      expect(result).toContain("a = 1;");
      expect(result).toContain("b = 2;");
      expect(result).toContain("c = 3;");
    });

    it("splits comma expressions inside function bodies", () => {
      const result = simplify("function f() { a = 1, b = 2; }");
      expect(result).toContain("a = 1;");
      expect(result).toContain("b = 2;");
    });

    it("does not split comma in return statement", () => {
      // return a,b returns b — splitting changes semantics
      const result = simplify("function f() { return a, b; }");
      expect(result).toContain("return");
      // Should preserve the comma operator or just return b
    });

    it("does not split commas in variable declarations", () => {
      const result = simplify("var a = 1, b = 2;");
      // Should stay as a single var declaration with two declarators
      expect(result).toContain("var");
    });

    it("does not split commas in for-loop init", () => {
      const result = simplify("for (a = 1, b = 2;;) {}");
      expect(result).toContain("for");
    });

    it("does not split commas in for-loop update", () => {
      const result = simplify("for (;; a++, b++) {}");
      expect(result).toContain("for");
    });

    it("splits nested comma expressions", () => {
      const result = simplify("function f() { x = 1, y = 2, z = 3; }");
      expect(result).toContain("x = 1;");
      expect(result).toContain("y = 2;");
      expect(result).toContain("z = 3;");
    });
  });

  describe("computed member to dot access", () => {
    it("converts obj['prop'] to obj.prop for valid identifiers", () => {
      const result = simplify('obj["prop"]');
      expect(result).toContain("obj.prop");
    });

    it("converts obj['length'] to obj.length", () => {
      const result = simplify('x["length"]');
      expect(result).toContain("x.length");
    });

    it("preserves computed access for non-identifier keys", () => {
      const result = simplify('obj["some-prop"]');
      expect(result).toContain('["some-prop"]');
    });

    it("preserves computed access for variable keys", () => {
      const result = simplify("obj[key]");
      expect(result).toContain("obj[key]");
    });

    it("preserves computed access for numeric keys", () => {
      const result = simplify("arr[0]");
      expect(result).toContain("arr[0]");
    });
  });

  describe("logical expression to if-statement", () => {
    it("converts a && b() to if (a) b()", () => {
      const result = simplify("a && b();");
      expect(result).toContain("if (a)");
      expect(result).toContain("b()");
      expect(result).not.toContain("&&");
    });

    it("converts a || b() to if (!a) b()", () => {
      const result = simplify("a || b();");
      expect(result).toContain("if (!a)");
      expect(result).toContain("b()");
      expect(result).not.toContain("||");
    });

    it("does not convert logical in non-statement context", () => {
      const result = simplify("var x = a && b();");
      expect(result).toContain("&&");
    });
  });

  describe("ternary to if-statement", () => {
    it("converts a ? b() : c() to if/else", () => {
      const result = simplify("a ? b() : c();");
      expect(result).toContain("if (a)");
      expect(result).toContain("b()");
      expect(result).toContain("else");
      expect(result).toContain("c()");
    });

    it("does not convert ternary in non-statement context", () => {
      const result = simplify("var x = a ? b() : c();");
      expect(result).toContain("?");
    });
  });

  describe("merge else-if", () => {
    it("merges else { if } into else if", () => {
      const result = simplify("if (a) { x(); } else { if (b) { y(); } }");
      expect(result).toContain("else if (b)");
    });
  });

  describe("yoda condition flipping", () => {
    it("flips literal === variable", () => {
      const result = simplify('if ("string" === x) {}');
      expect(result).toContain('x === "string"');
    });

    it("flips literal !== variable", () => {
      const result = simplify("if (0 !== x) {}");
      expect(result).toContain("x !== 0");
    });

    it("does not flip variable === variable", () => {
      const result = simplify("if (a === b) {}");
      expect(result).toContain("a === b");
    });
  });

  describe("empty block cleanup", () => {
    it("removes empty else block", () => {
      const result = simplify("if (a) { b(); } else {}");
      expect(result).not.toContain("else");
    });

    it("removes else block with only pure literal", () => {
      const result = simplify("if (a) { b(); } else { 0; }");
      expect(result).not.toContain("else");
      expect(result).toContain("if (a)");
      expect(result).toContain("b()");
    });

    it("inverts if with empty consequent and non-empty alternate", () => {
      const result = simplify("if (a) {} else { b(); }");
      expect(result).toContain("if (!a)");
      expect(result).toContain("b()");
      expect(result).not.toContain("else");
    });

    it("inverts if with pure-literal consequent and non-empty alternate", () => {
      const result = simplify("if (a) { 0; } else { b(); }");
      expect(result).toContain("if (!a)");
      expect(result).toContain("b()");
      expect(result).not.toContain("else");
    });
  });

  describe("ternary with pure alternate", () => {
    it("drops pure literal alternate from ternary conversion", () => {
      const result = simplify("a ? b() : 0;");
      expect(result).toContain("if (a)");
      expect(result).toContain("b()");
      expect(result).not.toContain("else");
      expect(result).not.toContain("0");
    });
  });
});
