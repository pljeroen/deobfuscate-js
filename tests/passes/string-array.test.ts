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

    it("resolves single-element string arrays", () => {
      const result = deobfuscate(`
        function _0x1258() {
          var _0x4e = ['log'];
          _0x1258 = function() { return _0x4e; };
          return _0x1258();
        }
        function _0x6b1a(idx) {
          idx = idx - 0;
          var arr = _0x1258();
          return arr[idx];
        }
        console[_0x6b1a(0)](42);
      `);
      expect(result).toContain('"log"');
      expect(result).not.toContain("_0x1258");
      expect(result).not.toContain("_0x6b1a");
    });

    it("resolves two-element string arrays", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0x4e2c");
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

  describe("top-level aliases", () => {
    it("resolves top-level alias of decoder function", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        var _0xalias = _0xdec;
        console[_0xalias(0)](_0xalias(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0xalias");
      expect(result).not.toContain("_0xdec");
    });

    it("resolves multiple chained top-level aliases", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        var _0xalias1 = _0xdec;
        var _0xalias2 = _0xdec;
        console[_0xalias1(0)](_0xalias2(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0xalias1");
      expect(result).not.toContain("_0xalias2");
    });

    it("removes top-level alias declaration after resolution", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        var _0xalias = _0xdec;
        console[_0xalias(0)](_0xalias(1));
      `);
      expect(result).not.toContain("_0xalias");
      expect(result).not.toContain("_0x4e2c");
    });

    it("resolves top-level alias with rotation", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['world', 'foo', 'bar', 'log', 'Hello'];
        (function(arr, n) { while(n--) { arr.push(arr.shift()); } })(_0x4e2c, 3);
        function _0xdec(idx) { return _0x4e2c[idx]; }
        var _0xalias = _0xdec;
        console[_0xalias(0)](_0xalias(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0xalias");
    });

    it("resolves top-level alias with a0_0x prefix (no duplicate declaration)", () => {
      const result = deobfuscate(`
        const a0_0x61431b = a0_0x2c31;
        function a0_0x3c57() {
          const _0x29208c = ['log', 'Hello', 'world', 'foo', 'bar'];
          a0_0x3c57 = function() { return _0x29208c; };
          return a0_0x3c57();
        }
        function a0_0x2c31(idx) {
          const arr = a0_0x3c57();
          a0_0x2c31 = function(i) { return arr[i]; };
          return a0_0x2c31(idx);
        }
        console[a0_0x61431b(0)](a0_0x61431b(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("a0_0x");
    });

    it("resolves a0_0x decoder calls via top-level alias", () => {
      const result = deobfuscate(`
        const a0_0x61431b = a0_0x2c31;
        function a0_0x3c57() {
          const _0x29208c = ['log', 'Hello', 'world', 'foo', 'bar'];
          a0_0x3c57 = function() { return _0x29208c; };
          return a0_0x3c57();
        }
        function a0_0x2c31(idx) {
          const arr = a0_0x3c57();
          a0_0x2c31 = function(i) { return arr[i]; };
          return a0_0x2c31(idx);
        }
        console[a0_0x61431b(0)](a0_0x61431b(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      // Decoder infrastructure should be removed
      expect(result).not.toContain("a0_0x3c57");
      expect(result).not.toContain("a0_0x2c31");
    });

    it("does not break existing function-scoped alias resolution", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        function user() {
          var _0xlocal = _0xdec;
          console[_0xlocal(0)](_0xlocal(1));
        }
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
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

  describe("R20: self-overwriting string array function", () => {
    it("detects self-overwriting function as string array source", () => {
      const result = deobfuscate(`
        function _0x5246() {
          var _0x4dec = ['log', 'Hello', 'world', 'foo', 'bar'];
          _0x5246 = function() { return _0x4dec; };
          return _0x5246();
        }
        function _0xdec(idx) { return _0x5246()[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0x5246");
      expect(result).not.toContain("_0xdec");
    });

    it("detects self-overwriting function with rotation IIFE", () => {
      const result = deobfuscate(`
        function _0x5246() {
          var _0x4dec = ['world', 'foo', 'bar', 'log', 'Hello'];
          _0x5246 = function() { return _0x4dec; };
          return _0x5246();
        }
        (function(fn, n) { var arr = fn(); while(n--) { arr.push(arr.shift()); } })(_0x5246, 3);
        function _0xdec(idx) { return _0x5246()[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0x5246");
    });
  });

  describe("R21: wrapper decoder functions with offset objects", () => {
    it("resolves single wrapper function with offset arithmetic", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        function _0xwrap(a, b) { return _0xdec(b - -0x64); }
        console[_0xwrap(0, -0x64)](_0xwrap(0, -0x63));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0xwrap");
    });

    it("resolves multiple wrappers pointing to same decoder", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        function _0xwrapA(a, b) { return _0xdec(b - -0x64); }
        function _0xwrapB(a, b) { return _0xdec(a - 0x100); }
        console[_0xwrapA(0, -0x64)](_0xwrapB(0x101, 0));
      `);
      // _0xwrapA(0, -0x64) => _0xdec(-0x64 - -0x64) => _0xdec(0) => 'log'
      // _0xwrapB(0x101, 0) => _0xdec(0x101 - 0x100) => _0xdec(1) => 'Hello'
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0xwrapA");
      expect(result).not.toContain("_0xwrapB");
    });

    it("resolves wrapper calls with offset object arguments", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        function _0xwrap(a, b) { return _0xdec(b - -0x64); }
        var _0xobj = { _0xaa: 0x64, _0xbb: 0x63 };
        console[_0xwrap(0, -_0xobj._0xaa)](_0xwrap(0, -_0xobj._0xbb));
      `);
      // _0xwrap(0, -0x64) => _0xdec(-0x64 - -0x64) => _0xdec(0) => 'log'
      // _0xwrap(0, -0x63) => _0xdec(-0x63 - -0x64) => _0xdec(1) => 'Hello'
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });

    it("resolves wrappers with local offset object in wrapper body", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        function _0xwrap(a, b) {
          var _0xlocal = { _0xoff: 0xce };
          return _0xdec(a - -_0xlocal._0xoff);
        }
        _0xwrap(-0xce, 0);
        _0xwrap(-0xcd, 0);
      `);
      // _0xwrap(-0xce, 0) => _0xdec(-0xce - -0xce) => _0xdec(0) => 'log'
      // _0xwrap(-0xcd, 0) => _0xdec(-0xcd - -0xce) => _0xdec(1) => 'Hello'
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });

    it("handles self-overwriting array + wrappers + offset objects end-to-end", () => {
      const result = deobfuscate(`
        function _0x5246() {
          var _0x4dec = ['log', 'Hello', 'world', 'foo', 'bar'];
          _0x5246 = function() { return _0x4dec; };
          return _0x5246();
        }
        function _0xdec(idx, key) {
          idx = idx - 0x50;
          var arr = _0x5246();
          return arr[idx];
        }
        function _0xwrapA(a, b) { return _0xdec(b - -0x100, a); }
        function _0xwrapB(a, b) { return _0xdec(a - 0x200, b); }
        var _0xobj = { _0xp1: 0xb0, _0xp2: 0xaf };
        console[_0xwrapA(0, -_0xobj._0xp1)](_0xwrapA(0, -_0xobj._0xaf));
        var msg = _0xwrapB(0x252, 0);
      `);
      // _0xwrapA(0, -0xb0) => _0xdec(-0xb0 - -0x100, 0) => _0xdec(0x50, 0) => arr[0x50 - 0x50] = arr[0] => 'log'
      // _0xwrapB(0x252, 0) => _0xdec(0x252 - 0x200, 0) => _0xdec(0x52, 0) => arr[0x52 - 0x50] = arr[2] => 'world'
      expect(result).toContain('"log"');
      expect(result).toContain('"world"');
      expect(result).not.toContain("_0x5246");
      expect(result).not.toContain("_0xdec");
    });

    it("resolves aliases inside arrow function callbacks", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        var arr = [1, 2, 3];
        arr.forEach(x => {
          var _0xalias = _0xdec;
          console[_0xalias(0)](_0xalias(1));
        });
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0xalias");
      expect(result).not.toContain("_0x4e2c");
    });

    it("does not match user function that mentions decoder in non-call context", () => {
      // This function references the decoder name in a string, but doesn't forward-call it
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        function userFn(a, b) { var name = "_0xdec"; return a + b; }
        console[_0xdec(0)](_0xdec(1));
        userFn(1, 2);
      `);
      expect(result).toContain('"log"');
      // userFn should NOT be removed — it's a user function, not a wrapper
      expect(result).toContain("userFn");
    });

    it("removes wrapper functions and setup after resolution", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        function _0xwrap(a, b) { return _0xdec(b - -0x64); }
        console[_0xwrap(0, -0x64)](_0xwrap(0, -0x63));
      `);
      expect(result).not.toContain("_0x4e2c");
      expect(result).not.toContain("_0xdec");
      expect(result).not.toContain("_0xwrap");
    });
  });
});
