import { describe, it, expect } from "vitest";
import { renamePass } from "../../src/passes/rename.js";

const ren = (s: string) => renamePass.run(s);

describe("rename pass", () => {
  describe("function parameters", () => {
    it("renames single-letter params to descriptive names", () => {
      const result = ren("function f(n,t,r){return n+t+r}");
      expect(result).not.toContain("(n,");
      expect(result).not.toContain(",t,");
      expect(result).not.toContain(",r)");
      // The param names should appear in the body too
      expect(result).toContain("return ");
    });

    it("renames arrow function params", () => {
      const result = ren("(n,t)=>n+t");
      expect(result).not.toMatch(/[(,]n[),]/);
      expect(result).not.toMatch(/[(,]t[),]/);
    });
  });

  describe("preserves conventional names", () => {
    it("keeps loop variable i", () => {
      expect(ren("for(var i=0;i<n;i++){}")).toContain("i=0");
      expect(ren("for(var i=0;i<n;i++){}")).toContain("i++");
    });

    it("keeps underscore _", () => {
      expect(ren("var _=root._")).toContain("_");
    });

    it("keeps dollar sign $", () => {
      expect(ren("var $=jQuery")).toContain("$");
    });
  });

  describe("property access", () => {
    it("does not rename property names after dot", () => {
      const result = ren("n.length");
      // 'length' must survive
      expect(result).toContain(".length");
    });

    it("does not rename object keys", () => {
      // This is a simplification — object keys in {key: val} should stay
      const result = ren("{a:1,b:2}");
      expect(result).toContain("a:");
      expect(result).toContain("b:");
    });
  });

  describe("scope isolation", () => {
    it("renames independently per function scope", () => {
      const input = "function f(n){return n} function g(n){return n}";
      const result = ren(input);
      // Both functions should have their params renamed
      // but they might get the same generated name since they're independent scopes
      expect(result).not.toMatch(/\(n\)/);
    });
  });

  describe("consistency", () => {
    it("uses the same name for all occurrences within a scope", () => {
      const result = ren("function f(n){return n+n}");
      // Extract the param name — whatever it got renamed to
      const match = result.match(/function \w+\((\w+)\)/);
      expect(match).toBeTruthy();
      if (match) {
        const paramName = match[1];
        // Should appear 3 times: declaration + 2 uses
        const occurrences = result.split(paramName).length - 1;
        expect(occurrences).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe("no crash on real input", () => {
    it("renames a minified snippet without throwing", () => {
      const snippet = `function Vn(n,t,r){var e=t&1,u=Fr(n);function o(){return this&&this!==undefined}return function(){var n=arguments;return u.apply(e?r:this,n)}}`;
      const result = ren(snippet);
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
