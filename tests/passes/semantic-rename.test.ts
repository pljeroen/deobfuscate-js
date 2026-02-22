import { describe, it, expect } from "vitest";
import { semanticRenamePass } from "../../src/passes/semantic-rename.js";
import { parse, generate } from "../../src/parser.js";

function deobfuscate(code: string): string {
  const ast = parse(code);
  const result = semanticRenamePass.run(ast);
  return generate(result);
}

describe("R17: semantic variable renaming", () => {
  describe("loop counters", () => {
    it("renames for-loop counter to i", () => {
      const result = deobfuscate(`
        for (var _0x1a = 0; _0x1a < 10; _0x1a++) {
          console.log(_0x1a);
        }
      `);
      expect(result).toContain("var i = 0");
      expect(result).toContain("i < 10");
      expect(result).toContain("i++");
      expect(result).not.toContain("_0x1a");
    });

    it("renames nested loop counters to i and j", () => {
      const result = deobfuscate(`
        for (var _0xa = 0; _0xa < 5; _0xa++) {
          for (var _0xb = 0; _0xb < 5; _0xb++) {
            console.log(_0xa, _0xb);
          }
        }
      `);
      expect(result).toContain("var i = 0");
      expect(result).toContain("var j = 0");
    });
  });

  describe("length-related variables", () => {
    it("renames variable used in .length comparison", () => {
      const result = deobfuscate(`
        function test(arr) {
          var _0x1b = arr.length;
          for (var _0x1a = 0; _0x1a < _0x1b; _0x1a++) {
            console.log(arr[_0x1a]);
          }
        }
      `);
      expect(result).toContain("len");
      expect(result).not.toContain("_0x1b");
    });
  });

  describe("callback parameters", () => {
    it("renames error-first callback parameter", () => {
      const result = deobfuscate(`
        function handler(_0x1a, _0x1b) {
          if (_0x1a) throw _0x1a;
          console.log(_0x1b);
        }
      `);
      // First param of error-first callback pattern should be 'err'
      expect(result).toContain("err");
    });
  });

  describe("safety", () => {
    it("does not rename already-meaningful names", () => {
      const result = deobfuscate(`
        function process(items) {
          var count = items.length;
          for (var i = 0; i < count; i++) {
            console.log(items[i]);
          }
        }
      `);
      expect(result).toContain("items");
      expect(result).toContain("count");
      expect(result).toContain("var i = 0");
    });

    it("does not rename globals", () => {
      const result = deobfuscate(`
        console.log(Math.PI);
        var x = JSON.stringify({});
      `);
      expect(result).toContain("console");
      expect(result).toContain("Math");
      expect(result).toContain("JSON");
    });

    it("recognizes a0_0x prefixed names as obfuscated", () => {
      const result = deobfuscate(`
        for (var a0_0x1a = 0; a0_0x1a < 10; a0_0x1a++) {
          console.log(a0_0x1a);
        }
      `);
      expect(result).toContain("var i = 0");
      expect(result).not.toContain("a0_0x1a");
    });

    it("does not modify code without obfuscated names", () => {
      const result = deobfuscate(`
        function add(a, b) { return a + b; }
        console.log(add(1, 2));
      `);
      expect(result).toContain("add");
      expect(result).toContain("return");
    });
  });

  describe("cross-scope collision avoidance", () => {
    it("does not rename nested scope variable to same name as outer scope rename", () => {
      // Both _0x1 and _0x2 match .length pattern → both would get "len".
      // The inner rename must NOT shadow the outer rename.
      const result = deobfuscate(`
        function outer(arr) {
          var _0x1 = arr.length;
          function inner(arr2) {
            var _0x2 = arr2.length;
            console.log(_0x1, _0x2);
          }
          return inner;
        }
      `);
      // Both should be renamed, but to DIFFERENT names
      expect(result).not.toContain("_0x1");
      expect(result).not.toContain("_0x2");
      // The inner function's variable must not shadow the outer's
      const match = result.match(/console\.log\((\w+),\s*(\w+)\)/);
      expect(match).toBeTruthy();
      expect(match![1]).not.toBe(match![2]);
    });

    it("does not shadow existing non-obfuscated name in parent scope", () => {
      // Parent scope has `len`. Inner scope has a .length _0x variable.
      // The inner rename must NOT pick `len` since it would shadow the parent.
      const result = deobfuscate(`
        function outer(arr) {
          var len = arr.length;
          function inner(arr2) {
            var _0x1 = arr2.length;
            console.log(len, _0x1);
          }
        }
      `);
      expect(result).not.toContain("_0x1");
      // `len` in console.log must still reference outer's variable
      const match = result.match(/console\.log\((\w+),\s*(\w+)\)/);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("len");
      expect(match![1]).not.toBe(match![2]);
    });
  });
});
