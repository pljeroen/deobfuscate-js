import { describe, it, expect } from "vitest";
import { simplifyPass } from "../../src/passes/simplify.js";

const simp = (s: string) => simplifyPass.run(s);

describe("simplify pass", () => {
  describe("boolean idioms", () => {
    it("replaces !0 with true", () => {
      expect(simp("return !0")).toBe("return true");
    });

    it("replaces !1 with false", () => {
      expect(simp("return !1")).toBe("return false");
    });

    it("does not replace !0 inside larger numbers like !00 or !02", () => {
      expect(simp("!00")).toBe("!00");
    });

    it("replaces multiple !0 and !1 in one expression", () => {
      // Top-level comma also gets split into statements
      expect(simp("a=!0,b=!1")).toBe("a=true;\nb=false");
    });

    it("replaces !0 and !1 inside parens (no comma split)", () => {
      expect(simp("f(!0,!1)")).toBe("f(true,false)");
    });

    it("handles !0 at end of input", () => {
      expect(simp("x=!0")).toBe("x=true");
    });

    it("handles !0 before punctuators", () => {
      expect(simp("return !0;")).toBe("return true;");
      expect(simp("a(!0)")).toBe("a(true)");
      expect(simp("[!0,!1]")).toBe("[true,false]");
    });
  });

  describe("void 0 to undefined", () => {
    it("replaces void 0 with undefined", () => {
      expect(simp("x===void 0")).toBe("x===undefined");
    });

    it("replaces void 0 with parens", () => {
      expect(simp("(void 0)")).toBe("(undefined)");
    });

    it("does not replace void with other operands", () => {
      expect(simp("void f()")).toBe("void f()");
    });
  });

  describe("comma expressions to statements", () => {
    it("splits top-level comma expressions into separate statements", () => {
      expect(simp("a=1,b=2,c=3;")).toBe("a=1;\nb=2;\nc=3;");
    });

    it("does not split commas inside function calls", () => {
      expect(simp("f(a,b,c)")).toBe("f(a,b,c)");
    });

    it("does not split commas inside var declarations", () => {
      expect(simp("var a=1,b=2")).toBe("var a=1,b=2");
    });

    it("does not split commas inside array literals", () => {
      expect(simp("[a,b,c]")).toBe("[a,b,c]");
    });

    it("does not split commas inside object literals", () => {
      expect(simp("{a:1,b:2}")).toBe("{a:1,b:2}");
    });

    it("splits comma expressions inside function bodies", () => {
      expect(simp("function f(){a=1,b=2,c=3}")).toBe(
        "function f(){a=1;\nb=2;\nc=3}"
      );
    });

    it("splits comma expressions after return inside function body", () => {
      // this.__x=a,this.__y=[] should become separate statements
      expect(simp("function f(){this.x=1,this.y=2}")).toBe(
        "function f(){this.x=1;\nthis.y=2}"
      );
    });

    it("does not split commas inside nested parens in function body", () => {
      expect(simp("function f(){g(a,b),h(c,d)}")).toBe(
        "function f(){g(a,b);\nh(c,d)}"
      );
    });

    it("splits commas inside function body even when inside var initializer", () => {
      // var de=function(){...} — the var declaration should NOT suppress
      // comma splitting inside the nested function body
      expect(simp("var de=function(){a=1,b=2}")).toBe(
        "var de=function(){a=1;\nb=2}"
      );
    });

    it("splits commas in deeply nested function inside var", () => {
      expect(simp("var x=function(){function Y(n){this.a=n,this.b=[]}};")).toBe(
        "var x=function(){function Y(n){this.a=n;\nthis.b=[]}};",
      );
    });

    it("preserves var declaration commas while splitting function body commas", () => {
      // var a=1,b=function(){x=1,y=2} — the var commas stay, function body commas split
      expect(simp("var a=1,b=function(){x=1,y=2}")).toBe(
        "var a=1,b=function(){x=1;\ny=2}"
      );
    });

    it("splits commas inside IIFE function bodies (parenDepth > 0)", () => {
      // (function(){a=1,b=2}).call(this) — the body is inside parens but commas should split
      expect(simp("(function(){a=1,b=2}).call(this)")).toBe(
        "(function(){a=1;\nb=2}).call(this)"
      );
    });

    it("does not split commas in function call args inside IIFE", () => {
      expect(simp("(function(){f(a,b)}).call(this)")).toBe(
        "(function(){f(a,b)}).call(this)"
      );
    });

    it("does not split commas inside brace-less do body", () => {
      expect(simp("do a(),b();while(c)")).toBe("do a(),b();while(c)");
    });

    it("does not split commas in do body inside function", () => {
      expect(simp("function f(){do a(),b();while(c);x=1,y=2}")).toBe(
        "function f(){do a(),b();while(c);x=1;\ny=2}"
      );
    });

    it("does not split commas in brace-less if body", () => {
      expect(simp("if(x) a=1,b=2;")).toBe("if(x) a=1,b=2;");
    });

    it("does not split commas in brace-less if body inside function", () => {
      expect(simp("function f(){if(x) a=1,b=2;c=3,d=4}")).toBe(
        "function f(){if(x) a=1,b=2;c=3;\nd=4}"
      );
    });

    it("does not split commas in brace-less else body", () => {
      expect(simp("if(x){a()}else b=1,c=2;")).toBe("if(x){a()}else b=1,c=2;");
    });

    it("does not split commas in brace-less for body", () => {
      expect(simp("for(var i=0;i<n;i++) a(i),b(i);")).toBe(
        "for(var i=0;i<n;i++) a(i),b(i);"
      );
    });

    it("does not split commas in return expressions", () => {
      // return a,b returns b — splitting would change semantics
      expect(simp("function f(){return a=1,b}")).toBe(
        "function f(){return a=1,b}"
      );
    });

    it("splits commas after return statement ends", () => {
      expect(simp("function f(){return a;b=1,c=2}")).toBe(
        "function f(){return a;b=1;\nc=2}"
      );
    });
  });

  describe("keyword merge prevention", () => {
    it("inserts space between return and true", () => {
      expect(simp("return!0")).toBe("return true");
    });

    it("inserts space between return and false", () => {
      expect(simp("return!1")).toBe("return false");
    });

    it("inserts space between typeof and true", () => {
      expect(simp("typeof!0")).toBe("typeof true");
    });

    it("does not insert space after punctuator", () => {
      expect(simp("(!0)")).toBe("(true)");
    });

    it("does not insert space after digit", () => {
      expect(simp("1+!0")).toBe("1+true");
    });
  });

  describe("combined", () => {
    it("applies all simplifications together", () => {
      expect(simp("return void 0===n?!0:!1")).toBe(
        "return undefined===n?true:false"
      );
    });
  });

  describe("no crash on real input", () => {
    it("simplifies a minified snippet without throwing", () => {
      const snippet = `n==null?void 0:n,!0===t&&!1===r`;
      const result = simp(snippet);
      expect(result).not.toContain("!0");
      expect(result).not.toContain("!1");
      expect(result).not.toContain("void 0");
    });
  });
});
