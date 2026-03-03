import { describe, it, expect } from "vitest";
import { deadCodeEliminatePass } from "../../src/passes/dead-code-eliminate.js";
import { parse, generate } from "../../src/parser.js";

function dce(code: string): string {
  const ast = parse(code);
  const result = deadCodeEliminatePass.run(ast);
  return generate(result);
}

describe("dead code elimination", () => {
  describe("unreachable branches", () => {
    it("removes if(false) block", () => {
      const result = dce("if (false) { console.log('dead'); }");
      expect(result).not.toContain("dead");
    });

    it("simplifies if(true) to consequent only", () => {
      const result = dce("if (true) { console.log('alive'); } else { console.log('dead'); }");
      expect(result).toContain("alive");
      expect(result).not.toContain("dead");
    });

    it("simplifies if(false) with else to alternate only", () => {
      const result = dce("if (false) { console.log('dead'); } else { console.log('alive'); }");
      expect(result).toContain("alive");
      expect(result).not.toContain("dead");
    });

    it("removes if(!true) block", () => {
      const result = dce("if (!true) { console.log('dead'); }");
      expect(result).not.toContain("dead");
    });
  });

  describe("ternary expressions", () => {
    it("simplifies true ? a : b to a", () => {
      const result = dce("console.log(true ? 'yes' : 'no');");
      expect(result).toContain("yes");
      expect(result).not.toContain("no");
    });

    it("simplifies false ? a : b to b", () => {
      const result = dce("console.log(false ? 'yes' : 'no');");
      expect(result).toContain("no");
      expect(result).not.toContain("yes");
    });
  });

  describe("unused variables", () => {
    it("removes unused const declaration", () => {
      const result = dce("const unused = 42; console.log('used');");
      expect(result).not.toContain("unused");
      expect(result).not.toContain("42");
      expect(result).toContain("used");
    });

    it("removes unused var declaration with literal value", () => {
      const result = dce("var unused = 'dead'; var used = 'alive'; console.log(used);");
      expect(result).not.toContain("dead");
      expect(result).toContain("alive");
    });

    it("does not remove variables with side effects in initializer", () => {
      const result = dce("var x = sideEffect(); console.log('ok');");
      // x is unused but sideEffect() may have effects — keep the call
      expect(result).toContain("sideEffect()");
    });

    it("does not remove variables that are referenced", () => {
      const result = dce("const x = 42; console.log(x);");
      expect(result).toContain("42");
    });
  });

  describe("unreachable code after return", () => {
    it("removes statements after return in function", () => {
      const result = dce("function f() { return 1; console.log('dead'); }");
      expect(result).not.toContain("dead");
      expect(result).toContain("return 1");
    });

    it("removes statements after throw", () => {
      const result = dce("function f() { throw new Error(); console.log('dead'); }");
      expect(result).not.toContain("dead");
    });
  });

  describe("preserves live code", () => {
    it("preserves normal if with variable condition", () => {
      const result = dce("if (x) { console.log('maybe'); }");
      expect(result).toContain("maybe");
    });

    it("preserves used variables", () => {
      const result = dce("const x = 1; const y = x + 2; console.log(y);");
      // x is used by y, y is used by console.log — both should stay
      expect(result).toContain("x + 2");
    });
  });

  describe("hoisted function declarations after return", () => {
    it("preserves FunctionDeclaration after return in IIFE", () => {
      const result = dce(`
        (function(data) {
          return data.map(stdev).join("\\n");
          function stdev(scores) {
            return scores.reduce(sum) / scores.length;
          }
          function sum(a, b) {
            return a + b;
          }
        })(input);
      `);
      // FunctionDeclarations are hoisted — must survive even after return
      expect(result).toContain("stdev");
      expect(result).toContain("sum");
    });

    it("still removes non-hoisted statements after return", () => {
      const result = dce(`
        function f() {
          return 1;
          var x = 2;
          console.log("dead");
        }
      `);
      expect(result).not.toContain("dead");
      expect(result).not.toContain("var x");
    });

    it("preserves FunctionDeclaration after throw", () => {
      const result = dce(`
        function f(x) {
          throw new Error(helper(x));
          function helper(v) { return v * 2; }
        }
      `);
      expect(result).toContain("helper");
    });
  });
});
