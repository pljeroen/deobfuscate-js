import { describe, it, expect } from "vitest";
import { controlFlowObjectPass } from "../../src/passes/control-flow-object.js";
import { parse, generate } from "../../src/parser.js";

function deobfuscate(code: string): string {
  const ast = parse(code);
  const result = controlFlowObjectPass.run(ast);
  return generate(result);
}

describe("control flow object inlining", () => {
  describe("binary expression proxies", () => {
    it("inlines addition proxy", () => {
      const result = deobfuscate(`
        const _0x4e08 = { AbCdE: function(x, y) { return x + y; } };
        var z = _0x4e08.AbCdE(a, b);
      `);
      expect(result).toContain("a + b");
      expect(result).not.toContain("_0x4e08");
    });

    it("inlines subtraction proxy", () => {
      const result = deobfuscate(`
        const _0x4e08 = { AbCdE: function(x, y) { return x - y; } };
        var z = _0x4e08.AbCdE(a, b);
      `);
      expect(result).toContain("a - b");
      expect(result).not.toContain("_0x4e08");
    });

    it("inlines comparison proxy", () => {
      const result = deobfuscate(`
        const obj = { xYzWq: function(x, y) { return x === y; } };
        if (obj.xYzWq(a, b)) {}
      `);
      expect(result).toContain("a === b");
      expect(result).not.toContain("obj");
    });

    it("inlines proxy with reversed param order", () => {
      // Obfuscator can generate function(a,b){return b-a} and call with swapped args
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return y - x; } };
        var z = obj.aBcDe(a, b);
      `);
      expect(result).toContain("b - a");
    });

    it("handles multiple proxies in one object", () => {
      const result = deobfuscate(`
        const _0x = {
          aBcDe: function(x, y) { return x + y; },
          fGhIj: function(x, y) { return x * y; }
        };
        var a = _0x.aBcDe(1, 2);
        var b = _0x.fGhIj(3, 4);
      `);
      expect(result).toContain("1 + 2");
      expect(result).toContain("3 * 4");
      expect(result).not.toContain("_0x");
    });
  });

  describe("logical expression proxies", () => {
    it("inlines && proxy", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return x && y; } };
        var z = obj.aBcDe(a, b);
      `);
      expect(result).toContain("a && b");
      expect(result).not.toContain("obj");
    });

    it("inlines || proxy", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return x || y; } };
        var z = obj.aBcDe(a, b);
      `);
      expect(result).toContain("a || b");
    });

    it("inlines ?? proxy", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return x ?? y; } };
        var z = obj.aBcDe(a, b);
      `);
      expect(result).toContain("a ?? b");
    });
  });

  describe("call expression proxies", () => {
    it("inlines simple call proxy", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(fn, a) { return fn(a); } };
        obj.aBcDe(console.log, "hello");
      `);
      expect(result).toContain('console.log("hello")');
      expect(result).not.toContain("obj");
    });

    it("inlines call proxy with multiple args", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(fn, a, b) { return fn(a, b); } };
        obj.aBcDe(Math.max, 1, 2);
      `);
      expect(result).toContain("Math.max(1, 2)");
    });

    it("inlines call proxy with rest params", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(fn, ...args) { return fn(...args); } };
        obj.aBcDe(foo, 1, 2, 3);
      `);
      expect(result).toContain("foo(1, 2, 3)");
    });
  });

  describe("string literal values", () => {
    it("inlines string literal property", () => {
      const result = deobfuscate(`
        const obj = {
          aBcDe: "hello world",
          fGhIj: function(x, y) { return x + y; }
        };
        console.log(obj.aBcDe);
        var z = obj.fGhIj(1, 2);
      `);
      expect(result).toContain('"hello world"');
      expect(result).toContain("1 + 2");
      expect(result).not.toContain("obj");
    });

    it("inlines string used as computed member access", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: "log" };
        console["log"](obj.aBcDe);
      `);
      // obj.aBcDe should be replaced with "log"
      expect(result).toContain('"log"');
      expect(result).not.toContain("obj");
    });
  });

  describe("bracket notation access", () => {
    it("inlines via bracket notation", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return x + y; } };
        var z = obj["aBcDe"](a, b);
      `);
      expect(result).toContain("a + b");
      expect(result).not.toContain("obj");
    });
  });

  describe("safety checks — does NOT inline when unsafe", () => {
    it("does not inline when binding is reassigned", () => {
      const result = deobfuscate(`
        let obj = { aBcDe: function(x, y) { return x + y; } };
        obj = {};
        var z = obj.aBcDe(a, b);
      `);
      // Should preserve original code since obj is mutated
      expect(result).toContain("obj");
    });

    it("does not inline when object is passed as argument", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return x + y; } };
        someFunction(obj);
        var z = obj.aBcDe(a, b);
      `);
      // obj is aliased — not safe to inline
      expect(result).toContain("obj");
    });

    it("does not inline when property is written to", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return x + y; } };
        obj.aBcDe = function(x, y) { return x - y; };
        var z = obj.aBcDe(a, b);
      `);
      expect(result).toContain("obj");
    });

    it("does not inline functions with free variables", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return x + globalVar; } };
        var z = obj.aBcDe(a, b);
      `);
      // Function references globalVar — not a pure proxy
      expect(result).toContain("obj");
    });

    it("does not inline functions with multiple statements", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { console.log(x); return x + y; } };
        var z = obj.aBcDe(a, b);
      `);
      // Function has side effects — not a pure proxy
      expect(result).toContain("obj");
    });
  });

  describe("transformObjectKeys pattern", () => {
    it("reassembles extracted object properties", () => {
      const result = deobfuscate(`
        var _0x = {};
        _0x["aBcDe"] = function(x, y) { return x + y; };
        _0x["fGhIj"] = "hello";
        var z = _0x.aBcDe(1, 2);
        console.log(_0x.fGhIj);
      `);
      expect(result).toContain("1 + 2");
      expect(result).toContain('"hello"');
      expect(result).not.toContain("_0x");
    });
  });

  describe("cleanup", () => {
    it("removes the storage object declaration after inlining", () => {
      const result = deobfuscate(`
        const obj = { aBcDe: function(x, y) { return x + y; } };
        var z = obj.aBcDe(1, 2);
      `);
      expect(result).not.toContain("const obj");
      expect(result).not.toContain("aBcDe");
    });
  });

  describe("real-world patterns", () => {
    it("handles mixed proxy types in single object", () => {
      const result = deobfuscate(`
        const _0x4e08 = {
          aBcDe: function(x, y) { return x + y; },
          fGhIj: function(x, y) { return x === y; },
          kLmNo: function(fn, a) { return fn(a); },
          pQrSt: "hello"
        };
        var sum = _0x4e08.aBcDe(1, 2);
        if (_0x4e08.fGhIj(a, b)) {
          _0x4e08.kLmNo(console.log, _0x4e08.pQrSt);
        }
      `);
      expect(result).toContain("1 + 2");
      expect(result).toContain("a === b");
      expect(result).toContain('console.log("hello")');
      expect(result).not.toContain("_0x4e08");
    });
  });

  describe("RC3: resilience to stale paths", () => {
    it("does not crash on Container is falsy errors", () => {
      // Pattern where multiple call sites of the same property exist in contexts
      // that may become stale during replacement (e.g., nested in same expression)
      const result = deobfuscate(`
        var _0x1234 = {
          'abc': function(a, b) { return a + b; },
          'def': "hello"
        };
        var x = _0x1234['abc'](_0x1234['abc'](1, 2), 3);
        console.log(_0x1234['def']);
      `);
      // Should not crash, and should inline at least partially
      expect(result).toContain("hello");
      expect(result).not.toContain("_0x1234");
    });
  });
});
