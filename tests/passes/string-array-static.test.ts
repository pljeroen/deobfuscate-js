import { describe, it, expect } from "vitest";
import { stringArrayStaticPass } from "../../src/passes/string-array-static.js";
import { parse, generate } from "../../src/parser.js";

function deobfuscate(code: string): string {
  const ast = parse(code);
  const result = stringArrayStaticPass.run(ast);
  return generate(result);
}

describe("string-array-static", () => {
  describe("existing: simple var array + decoder", () => {
    it("resolves flat string array with simple decoder", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world'];
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0x4e2c");
      expect(result).not.toContain("_0xdec");
    });

    it("resolves decoder with offset", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['log', 'Hello', 'world'];
        function _0xdec(idx) { idx = idx - 0x100; return _0x4e2c[idx]; }
        console[_0xdec(256)](_0xdec(257));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });
  });

  describe("self-overwriting array-provider function", () => {
    it("detects array inside self-overwriting function", () => {
      const result = deobfuscate(`
        function _0x1234() {
          var _0xarr = ['log', 'Hello', 'world'];
          _0x1234 = function() { return _0xarr; };
          return _0x1234();
        }
        function _0xdec(idx) { return _0x1234()[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("_0x1234");
      expect(result).not.toContain("_0xdec");
    });

    it("handles a0_0x prefix", () => {
      const result = deobfuscate(`
        function a0_0x2fa3() {
          var _0x36c35c = ['log', 'Hello', 'world'];
          a0_0x2fa3 = function() { return _0x36c35c; };
          return a0_0x2fa3();
        }
        function a0_0x5f4c(idx) { return a0_0x2fa3()[idx]; }
        console[a0_0x5f4c(0)](a0_0x5f4c(1));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
      expect(result).not.toContain("a0_0x");
    });
  });

  describe("self-overwriting decoder function", () => {
    it("detects self-overwriting decoder with zero offset", () => {
      const result = deobfuscate(`
        function a0_0x2fa3() {
          var _0x36c35c = ['readFileSync', 'stdin', 'split', 'log'];
          a0_0x2fa3 = function() { return _0x36c35c; };
          return a0_0x2fa3();
        }
        function a0_0x5f4c(eDcumr, key) {
          var stringArray = a0_0x2fa3();
          a0_0x5f4c = function(index, key) {
            index = index - 0x0;
            var value = stringArray[index];
            return value;
          };
          return a0_0x5f4c(eDcumr, key);
        }
        console[a0_0x5f4c(3)]('hello');
      `);
      expect(result).toContain('"log"');
      expect(result).not.toContain("a0_0x2fa3");
      expect(result).not.toContain("a0_0x5f4c");
    });

    it("detects self-overwriting decoder with nonzero offset", () => {
      const result = deobfuscate(`
        function _0x1234() {
          var _0xarr = ['log', 'Hello', 'world'];
          _0x1234 = function() { return _0xarr; };
          return _0x1234();
        }
        function _0x5678(p, k) {
          var arr = _0x1234();
          _0x5678 = function(i, k) {
            i = i - 0x50;
            var v = arr[i];
            return v;
          };
          return _0x5678(p, k);
        }
        console[_0x5678(0x50)](_0x5678(0x51));
      `);
      expect(result).toContain('"log"');
      expect(result).toContain('"Hello"');
    });
  });

  describe("alias tracking", () => {
    it("resolves top-level alias of decoder", () => {
      const result = deobfuscate(`
        function a0_0x2fa3() {
          var _0x36c35c = ['readFileSync', 'stdin', 'split'];
          a0_0x2fa3 = function() { return _0x36c35c; };
          return a0_0x2fa3();
        }
        var a0_0x54511d = a0_0x5f4c;
        function a0_0x5f4c(eDcumr, key) {
          var stringArray = a0_0x2fa3();
          a0_0x5f4c = function(index, key) {
            index = index - 0x0;
            var value = stringArray[index];
            return value;
          };
          return a0_0x5f4c(eDcumr, key);
        }
        require('fs')[a0_0x54511d(0)](a0_0x54511d(1));
      `);
      expect(result).toContain('"readFileSync"');
      expect(result).toContain('"stdin"');
      expect(result).not.toContain("a0_0x54511d");
    });

    it("resolves local aliases inside function bodies", () => {
      const result = deobfuscate(`
        function a0_0x2fa3() {
          var _0x36c35c = ['log', 'IVfRr'];
          a0_0x2fa3 = function() { return _0x36c35c; };
          return a0_0x2fa3();
        }
        function a0_0x5f4c(eDcumr, key) {
          var stringArray = a0_0x2fa3();
          a0_0x5f4c = function(index, key) {
            index = index - 0x0;
            var value = stringArray[index];
            return value;
          };
          return a0_0x5f4c(eDcumr, key);
        }
        function gcd(a, b) {
          var _0x1537c7 = a0_0x5f4c;
          if (_0x1537c7(1) !== 'IVfRr') {
            return a;
          }
          console[_0x1537c7(0)]('hello');
        }
      `);
      expect(result).toContain('"IVfRr"');
      expect(result).toContain('"log"');
      expect(result).not.toContain("_0x1537c7");
    });

    it("removes alias declarations after inlining", () => {
      const result = deobfuscate(`
        function _0x1234() {
          var _0xarr = ['log', 'Hello', 'world'];
          _0x1234 = function() { return _0xarr; };
          return _0x1234();
        }
        var _0xalias = _0x5678;
        function _0x5678(p) {
          var arr = _0x1234();
          _0x5678 = function(i) {
            i = i - 0x0;
            var v = arr[i];
            return v;
          };
          return _0x5678(p);
        }
        console[_0xalias(0)](_0xalias(1));
      `);
      expect(result).not.toContain("_0xalias");
      expect(result).not.toContain("_0x5678");
      expect(result).not.toContain("_0x1234");
    });
  });

  describe("deadcode-injection end-to-end", () => {
    it("enables dead code elimination after string resolution", () => {
      // Simulates the deadcode-injection pattern: string condition becomes evaluable
      const result = deobfuscate(`
        function a0_0x2fa3() {
          var _0x36c35c = ['IVfRr'];
          a0_0x2fa3 = function() { return _0x36c35c; };
          return a0_0x2fa3();
        }
        function a0_0x5f4c(p) {
          var arr = a0_0x2fa3();
          a0_0x5f4c = function(i) {
            i = i - 0x0;
            var v = arr[i];
            return v;
          };
          return a0_0x5f4c(p);
        }
        function test() {
          var _0xlocal = a0_0x5f4c;
          if ('IVfRr' !== _0xlocal(0)) {
            console.log('dead');
          } else {
            console.log('alive');
          }
        }
      `);
      // After resolution: if ('IVfRr' !== 'IVfRr') → constant false condition
      // The string should be resolved, enabling downstream DCE
      expect(result).toContain('"IVfRr"');
      expect(result).not.toContain("_0xlocal");
    });
  });

  describe("rotation guard", () => {
    it("bails out when rotation IIFE passes array provider as argument", () => {
      const result = deobfuscate(`
        function _0x1234() {
          var _0xarr = ['world', 'foo', 'bar', 'log', 'Hello'];
          _0x1234 = function() { return _0xarr; };
          return _0x1234();
        }
        (function(fn, target) {
          var arr = fn();
          while (true) {
            try {
              if (parseInt(arr[0]) === target) break;
              arr.push(arr.shift());
            } catch(e) { arr.push(arr.shift()); }
          }
        })(_0x1234, 12345);
        function _0x5678(p) {
          var arr = _0x1234();
          _0x5678 = function(i) {
            i = i - 0x0;
            var v = arr[i];
            return v;
          };
          return _0x5678(p);
        }
        console[_0x5678(0)](_0x5678(1));
      `);
      // Should NOT resolve — rotation changes element order
      expect(result).toContain("_0x5678");
    });

    it("bails out for simple rotation IIFE with var array", () => {
      const result = deobfuscate(`
        var _0x4e2c = ['world', 'foo', 'bar', 'log', 'Hello'];
        (function(arr, n) { while(n--) { arr.push(arr.shift()); } })(_0x4e2c, 3);
        function _0xdec(idx) { return _0x4e2c[idx]; }
        console[_0xdec(0)](_0xdec(1));
      `);
      // Should NOT resolve — rotation changes element order
      expect(result).toContain("_0x4e2c");
    });
  });

  describe("safety", () => {
    it("does not modify normal code", () => {
      const code = `function add(a, b) { return a + b; }`;
      const result = deobfuscate(code);
      expect(result).toContain("add");
    });

    it("does not modify non-obfuscated arrays", () => {
      const result = deobfuscate(`
        var config = ['debug', 'info'];
        console.log(config[0]);
      `);
      expect(result).toContain("config");
    });
  });
});
