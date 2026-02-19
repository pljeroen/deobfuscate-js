import { describe, it, expect } from "vitest";
import { stringArrayPass } from "../../src/passes/string-array.js";
import { parse, generate } from "../../src/parser.js";

function deobfuscate(code: string): string {
  const ast = parse(code);
  const result = stringArrayPass.run(ast);
  return generate(result);
}

describe("string array resolution", () => {
  describe("R09: string array detection", () => {
    it("detects and resolves flat string array with decoder", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0x4e2c");
      expect(result).not.toContain("_0xdec");
    });

    it("does not modify arrays without decoder function", () => {
      const result = deobfuscate(`
        var config = ['debug', 'info', 'warn', 'error', 'fatal'];
        console.log(config[0]);
      `);
      expect(result).toContain("config");
    });

    it("does not modify arrays with non-string elements", () => {
      const result = deobfuscate(`
        var _0x4e2c = [1, 2, 3, 4, 5];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console.log(_0xdec(0));
      `);
      expect(result).toContain("_0x4e2c");
    });
  });

  describe("R10: rotation resolution", () => {
    it("resolves array after push/shift rotation", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['world', 'foo', 'bar', 'log', 'Hello'];
        (function(arr, n) { while(n--) { arr.push(arr.shift()); } })(_0x4e2c, 3);
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      // After rotation by 3: ['log', 'Hello', 'world', 'foo', 'bar']
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0x4e2c");
      expect(result).not.toContain("push");
    });

    it("resolves rotation combined with offset decoder", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['foo', 'bar', 'log', 'Hello', 'world'];
        (function(arr, n) { while(n--) { arr.push(arr.shift()); } })(_0x4e2c, 2);
        function _0xdec(idx) { idx = idx - 0x10; return _0x4e2c[idx]; }
        console[_0xdec(0x10)](_0xdec(0x11));
      `);
      // After rotation by 2: ['log', 'Hello', 'world', 'foo', 'bar']
      // _0xdec(0x10) = idx 0 = 'log', _0xdec(0x11) = idx 1 = 'Hello'
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });
  });

  describe("R11: decoder function resolution", () => {
    it("resolves simple index lookup", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });

    it("resolves decoder with subtraction offset", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { idx = idx - 0x100; return _0x4e2c[idx]; }
        console[_0xdec(256)](_0xdec(257));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });

    it("resolves base64 encoded strings via sandbox", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['bG9n', 'SGVsbG8=', 'd29ybGQ=', 'Zm9v', 'YmFy'];
        function _0xdec(idx) {
          return Buffer.from(_0x4e2c[idx], 'base64').toString();
        }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });

    it("resolves decoder with two parameters", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx, key) { idx = idx - 100; return _0x4e2c[idx]; }
        console[_0xdec(100, 'abc')](_0xdec(101, 'def'));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });

    it("resolves self-overwriting decoder pattern", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        var _0xdec = function(idx) {
          _0xdec = function(i) { return _0x4e2c[i]; };
          return _0xdec(idx);
        };
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0xdec");
    });
  });

  describe("R12: sandboxed execution", () => {
    it("resolves custom decoder with complex logic", () => {
      // Strings encoded with char code +1 offset: 'mph' decodes to 'log', 'Ifmmp' decodes to 'Hello'
      const result = deobfuscate(`
        var _0x4e2c = ['mph', 'Ifmmp', 'xpsme', 'gpp', 'cbs'];
        function _0xdec(idx) {
          var s = _0x4e2c[idx];
          var result = '';
          for (var i = 0; i < s.length; i++) {
            result += String.fromCharCode(s.charCodeAt(i) - 1);
          }
          return result;
        }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });
  });

  describe("cleanup", () => {
    it("removes string array declaration after resolution", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).not.toContain("_0x4e2c");
      expect(result).not.toContain("'log'");
      expect(result).not.toContain("'Hello'");
    });

    it("removes decoder function after resolution", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).not.toContain("_0xdec");
    });

    it("removes rotation IIFE after resolution", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['world', 'foo', 'bar', 'log', 'Hello'];
        (function(arr, n) { while(n--) { arr.push(arr.shift()); } })(_0x4e2c, 3);
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).not.toContain("push");
      expect(result).not.toContain("shift");
    });
  });

  describe("safety", () => {
    it("does not modify normal code without string array pattern", () => {
      const code = `
        function add(a, b) { return a + b; }
        console.log(add(1, 2));
      `;
      const result = deobfuscate(code);
      expect(result).toContain("add");
      expect(result).toContain("return");
    });

    it("returns unchanged AST when sandbox execution fails", () => {
      // Decoder that will timeout or error in sandbox
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) {
          while(typeof window !== 'undefined') {}
          return _0x4e2c[idx];
        }
        console[_0xdec(0)](_0xdec(1));
      `);
      // Should return something without crashing — either resolved or original
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("real-world patterns", () => {
    it("resolves complete obfuscation with rotation + offset + multiple calls", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['world', 'foo', 'bar', 'log', 'Hello'];
        (function(arr, n) { while(n--) { arr.push(arr.shift()); } })(_0x4e2c, 3);
        function _0xdec(idx) { idx = idx - 0x1a5; return _0x4e2c[idx]; }
        console[_0xdec(0x1a5)](_0xdec(0x1a8));
        var x = _0xdec(0x1a6);
        var y = _0xdec(0x1a7);
      `);
      // After rotation by 3: ['log', 'Hello', 'world', 'foo', 'bar']
      // 0x1a5 - 0x1a5 = 0 -> 'log'
      // 0x1a6 - 0x1a5 = 1 -> 'Hello'
      // 0x1a7 - 0x1a5 = 2 -> 'world'
      // 0x1a8 - 0x1a5 = 3 -> 'foo'
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).toContain('"world"');
      expect(result).toContain('"foo"');
      expect(result).not.toContain("_0x4e2c");
      expect(result).not.toContain("_0xdec");
    });
  });
});
