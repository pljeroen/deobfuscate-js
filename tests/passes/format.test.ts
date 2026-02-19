import { describe, it, expect } from "vitest";
import { formatPass } from "../../src/passes/format.js";

const fmt = (s: string) => formatPass.run(s);

describe("format pass", () => {
  describe("line breaks", () => {
    it("inserts newline after semicolons", () => {
      expect(fmt("var a=1;var b=2;")).toBe("var a = 1;\nvar b = 2;\n");
    });

    it("inserts newline after opening brace", () => {
      expect(fmt("function f(){return 1}")).toBe(
        "function f() {\n  return 1\n}\n"
      );
    });

    it("inserts newline before closing brace", () => {
      expect(fmt("{a;b}")).toBe("{\n  a;\n  b\n}\n");
    });
  });

  describe("indentation", () => {
    it("indents nested blocks", () => {
      expect(fmt("if(a){if(b){c}}")).toBe(
        "if (a) {\n  if (b) {\n    c\n  }\n}\n"
      );
    });

    it("handles multiple closing braces", () => {
      expect(fmt("function f(){if(a){b}}")).toBe(
        "function f() {\n  if (a) {\n    b\n  }\n}\n"
      );
    });
  });

  describe("spacing", () => {
    it("adds spaces around binary operators", () => {
      expect(fmt("a+b")).toBe("a + b\n");
    });

    it("adds spaces around assignment", () => {
      expect(fmt("a=1")).toBe("a = 1\n");
    });

    it("adds spaces around comparison operators", () => {
      expect(fmt("a===b")).toBe("a === b\n");
    });

    it("adds space after comma", () => {
      expect(fmt("f(a,b,c)")).toBe("f(a, b, c)\n");
    });

    it("adds space after keywords like if, for, while", () => {
      expect(fmt("if(a){}")).toBe("if (a) {\n}\n");
    });

    it("does not add space after function name", () => {
      expect(fmt("function foo(){}")).toBe("function foo() {\n}\n");
    });
  });

  describe("for loops", () => {
    it("does not break on semicolons inside for()", () => {
      expect(fmt("for(var i=0;i<n;i++){x}")).toBe(
        "for (var i = 0; i < n; i++) {\n  x\n}\n"
      );
    });
  });

  describe("object literals", () => {
    it("formats object properties on separate lines", () => {
      expect(fmt("var o={a:1,b:2}")).toBe(
        "var o = {\n  a: 1,\n  b: 2\n}\n"
      );
    });
  });

  describe("empty blocks", () => {
    it("keeps empty blocks compact", () => {
      expect(fmt("function f(){}")).toBe("function f() {\n}\n");
    });
  });

  describe("keyword-to-word spacing", () => {
    it("adds space between return and identifier", () => {
      expect(fmt("return x")).toBe("return x\n");
    });

    it("adds space between return and boolean keyword", () => {
      expect(fmt("if(a)return false;return true;")).toBe(
        "if (a) return false;\nreturn true;\n"
      );
    });

    it("adds space between return and unary operator", () => {
      expect(fmt("return!x")).toBe("return !x\n");
      expect(fmt("return-1")).toBe("return -1\n");
      expect(fmt("return~x")).toBe("return ~x\n");
    });

    it("adds space between return and string/number", () => {
      expect(fmt('return"hello"')).toBe('return "hello"\n');
      expect(fmt("return 42")).toBe("return 42\n");
    });

    it("adds space between throw and expression", () => {
      expect(fmt("throw new Error()")).toBe("throw new Error()\n");
    });

    it("adds space between typeof and operand", () => {
      expect(fmt('typeof x==="string"')).toBe('typeof x === "string"\n');
    });

    it("adds space between new and constructor", () => {
      expect(fmt("new Array(1)")).toBe("new Array(1)\n");
    });

    it("adds space between delete and operand", () => {
      expect(fmt("delete obj.x")).toBe("delete obj.x\n");
    });

    it("adds space between case and value", () => {
      expect(fmt("case 1:return x")).toBe("case 1: return x\n");
    });
  });

  describe("ternary operator", () => {
    it("adds spaces around ? and :", () => {
      expect(fmt("a?b:c")).toBe("a ? b : c\n");
    });

    it("spaces ternary with complex expressions", () => {
      expect(fmt("x===y?1:0")).toBe("x === y ? 1 : 0\n");
    });

    it("handles nested ternary", () => {
      expect(fmt("a?b?c:d:e")).toBe("a ? b ? c : d : e\n");
    });

    it("keeps object key colon as ': ' inside ternary branch", () => {
      expect(fmt("var o={a:1}")).toBe("var o = {\n  a: 1\n}\n");
    });

    it("distinguishes ternary colon from case label colon", () => {
      expect(fmt("case 1:return x")).toBe("case 1: return x\n");
    });
  });

  describe("brace attachment", () => {
    it("attaches semicolon to closing brace", () => {
      expect(fmt("var f=function(){x};")).toBe(
        "var f = function() {\n  x\n};\n"
      );
    });

    it("attaches closing paren to closing brace", () => {
      expect(fmt("(function(){x})()")).toBe(
        "(function() {\n  x\n})()\n"
      );
    });

    it("attaches comma to closing brace", () => {
      expect(fmt("[function(){x},1]")).toBe(
        "[function() {\n  x\n}, 1]\n"
      );
    });
  });

  describe("unary minus", () => {
    it("does not add space in negative numbers after assignment", () => {
      expect(fmt("x=-1")).toBe("x = -1\n");
    });

    it("does not add space in negative numbers after return", () => {
      expect(fmt("return-1")).toBe("return -1\n");
    });

    it("does not add space in negative numbers after comma", () => {
      expect(fmt("f(a,-1)")).toBe("f(a, -1)\n");
    });

    it("does not add space in negative numbers after open paren", () => {
      expect(fmt("(-1)")).toBe("(-1)\n");
    });

    it("keeps space for binary minus", () => {
      expect(fmt("a-b")).toBe("a - b\n");
    });
  });

  describe("no crash on real input", () => {
    it("formats a minified snippet without throwing", () => {
      const snippet = `;(function(){function n(n,t,r){switch(n){case 1:return t;case 2:return r}}}).call(this);`;
      const result = fmt(snippet);
      expect(result).toBeTruthy();
      expect(result.split("\n").length).toBeGreaterThan(5);
    });
  });
});
