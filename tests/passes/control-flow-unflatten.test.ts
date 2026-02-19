import { describe, it, expect } from "vitest";
import { controlFlowUnflattenPass } from "../../src/passes/control-flow-unflatten.js";
import { parse, generate } from "../../src/parser.js";

function deobfuscate(code: string): string {
  const ast = parse(code);
  const result = controlFlowUnflattenPass.run(ast);
  return generate(result);
}

describe("control flow unflattening", () => {
  describe("R13: dispatch pattern detection", () => {
    it("reconstructs ordered statements from switch dispatch", () => {
      const result = deobfuscate(`
        var _0x = '2|0|1'.split('|');
        var _0xi = 0;
        while (true) {
          switch (_0x[_0xi++]) {
            case '0': console.log('second'); continue;
            case '1': console.log('third'); continue;
            case '2': console.log('first'); continue;
          }
          break;
        }
      `);
      // Order is 2, 0, 1 → 'first', 'second', 'third'
      expect(result).toContain("'first'");
      expect(result).toContain("'second'");
      expect(result).toContain("'third'");
      expect(result.indexOf("'first'")).toBeLessThan(result.indexOf("'second'"));
      expect(result.indexOf("'second'")).toBeLessThan(result.indexOf("'third'"));
      expect(result).not.toContain("switch");
      expect(result).not.toContain("while");
    });

    it("handles while(!![]) truthy test pattern", () => {
      const result = deobfuscate(`
        var _0x = '1|0'.split('|');
        var _0xi = 0;
        while (!![]) {
          switch (_0x[_0xi++]) {
            case '0': console.log('B'); continue;
            case '1': console.log('A'); continue;
          }
          break;
        }
      `);
      expect(result.indexOf("'A'")).toBeLessThan(result.indexOf("'B'"));
      expect(result).not.toContain("switch");
    });

    it("handles multiple statements per case", () => {
      const result = deobfuscate(`
        var _0x = '1|0'.split('|');
        var _0xi = 0;
        while (true) {
          switch (_0x[_0xi++]) {
            case '0': var y = 2; console.log(y); continue;
            case '1': var x = 1; console.log(x); continue;
          }
          break;
        }
      `);
      expect(result.indexOf("x = 1")).toBeLessThan(result.indexOf("y = 2"));
    });

    it("handles 5-element dispatch with assignments and calls", () => {
      const result = deobfuscate(`
        var _0x = '4|2|0|3|1'.split('|');
        var _0xi = 0;
        while (true) {
          switch (_0x[_0xi++]) {
            case '0': var c = a + b; continue;
            case '1': console.log(result); continue;
            case '2': var b = 20; continue;
            case '3': var result = c * 2; continue;
            case '4': var a = 10; continue;
          }
          break;
        }
      `);
      // Order: 4,2,0,3,1 → a=10, b=20, c=a+b, result=c*2, console.log(result)
      const aIdx = result.indexOf("a = 10");
      const bIdx = result.indexOf("b = 20");
      const cIdx = result.indexOf("c = a + b");
      const rIdx = result.indexOf("result = c * 2");
      const logIdx = result.indexOf("console.log");
      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
      expect(cIdx).toBeLessThan(rIdx);
      expect(rIdx).toBeLessThan(logIdx);
    });

    it("handles order array as direct array literal", () => {
      const result = deobfuscate(`
        var _0x = ['1', '0'];
        var _0xi = 0;
        while (true) {
          switch (_0x[_0xi++]) {
            case '0': console.log('B'); continue;
            case '1': console.log('A'); continue;
          }
          break;
        }
      `);
      expect(result.indexOf("'A'")).toBeLessThan(result.indexOf("'B'"));
      expect(result).not.toContain("switch");
    });
  });

  describe("cleanup", () => {
    it("removes dispatcher variables after unflattening", () => {
      const result = deobfuscate(`
        var _0x = '0|1'.split('|');
        var _0xi = 0;
        while (true) {
          switch (_0x[_0xi++]) {
            case '0': console.log('A'); continue;
            case '1': console.log('B'); continue;
          }
          break;
        }
      `);
      expect(result).not.toContain("split");
      expect(result).not.toContain("_0x");
    });

    it("preserves surrounding code", () => {
      const result = deobfuscate(`
        var before = 'hello';
        var _0x = '1|0'.split('|');
        var _0xi = 0;
        while (true) {
          switch (_0x[_0xi++]) {
            case '0': console.log('B'); continue;
            case '1': console.log('A'); continue;
          }
          break;
        }
        var after = 'world';
      `);
      expect(result).toContain("'hello'");
      expect(result).toContain("'world'");
      expect(result).not.toContain("switch");
    });
  });

  describe("safety", () => {
    it("does not modify normal while loops", () => {
      const result = deobfuscate(`
        var i = 0;
        while (i < 10) {
          console.log(i);
          i++;
        }
      `);
      expect(result).toContain("while");
      expect(result).toContain("i < 10");
    });

    it("does not modify switch without dispatch pattern", () => {
      const result = deobfuscate(`
        switch (x) {
          case 1: console.log('a'); break;
          case 2: console.log('b'); break;
        }
      `);
      expect(result).toContain("switch");
    });

    it("preserves continue statements in inner loops within cases", () => {
      const result = deobfuscate(`
        var _0x = '0|1'.split('|');
        var _0xi = 0;
        while (true) {
          switch (_0x[_0xi++]) {
            case '0':
              for (var j = 0; j < 10; j++) {
                if (j < 5) continue;
                console.log(j);
              }
              continue;
            case '1':
              console.log('done');
              continue;
          }
          break;
        }
      `);
      // The inner for loop's continue should be preserved
      expect(result).toContain("continue");
      expect(result).toContain("for");
      // But the dispatch while/switch should be gone
      expect(result).not.toContain("switch");
    });

    it("does not modify code without CFF pattern", () => {
      const code = `
        function add(a, b) { return a + b; }
        console.log(add(1, 2));
      `;
      const result = deobfuscate(code);
      expect(result).toContain("add");
      expect(result).toContain("return");
    });
  });
});
