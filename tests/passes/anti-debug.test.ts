import { describe, it, expect } from "vitest";
import { antiDebugPass } from "../../src/passes/anti-debug.js";
import { parse, generate } from "../../src/parser.js";

function ad(code: string): string {
  const ast = parse(code);
  const result = antiDebugPass.run(ast);
  return generate(result);
}

describe("anti-debug removal", () => {
  describe("constructor traps", () => {
    it("removes function with .constructor('debugger')", () => {
      const result = ad(`
        function _0x40ea98(x) {
          (function(){}).constructor("debugger").apply("stateObject");
        }
        _0x40ea98();
        console.log("keep");
      `);
      expect(result).not.toContain("debugger");
      expect(result).not.toContain("_0x40ea98");
      expect(result).toContain("keep");
    });

    it("removes function with .constructor('while (true) {}')", () => {
      const result = ad(`
        function _0xabc(x) {
          (function(){}).constructor("while (true) {}").apply("counter");
        }
        _0xabc(0);
        console.log("keep");
      `);
      expect(result).not.toContain("while");
      expect(result).not.toContain("_0xabc");
      expect(result).toContain("keep");
    });
  });

  describe("setInterval removal", () => {
    it("removes setInterval calling anti-debug function", () => {
      const result = ad(`
        function _0xdebug(x) {
          (function(){}).constructor("debugger").apply("stateObject");
        }
        setInterval(_0xdebug, 4000);
        console.log("keep");
      `);
      expect(result).not.toContain("setInterval");
      expect(result).not.toContain("_0xdebug");
      expect(result).toContain("keep");
    });
  });

  describe("self-defending pattern", () => {
    it("removes self-defending guard with (((.+)+)+)+$ regex", () => {
      const result = ad(`
        var _0x1234 = _0xfactory(this, function() {
          return _0x1234.toString().search("(((.+)+)+)+$").toString().constructor(_0x1234).search("(((.+)+)+)+$");
        });
        _0x1234();
        console.log("keep");
      `);
      expect(result).not.toContain("(((.+)+)+)+$");
      expect(result).not.toContain("_0x1234");
      expect(result).toContain("keep");
    });
  });

  describe("console override", () => {
    it("removes console-override IIFE", () => {
      const result = ad(`
        var _0xguard = someFactory(this, function() {
          var methods = ["log", "warn", "info", "error", "exception", "table", "trace"];
          for (var i = 0; i < methods.length; i++) {
            console[methods[i]] = function() {};
          }
        });
        _0xguard();
        console.log("keep");
      `);
      expect(result).not.toContain("_0xguard");
      expect(result).toContain("keep");
    });
  });

  describe("dead artifact cleanup", () => {
    it("removes unreferenced _0x variables after anti-debug removal", () => {
      const result = ad(`
        function _0xdebug(x) {
          (function(){}).constructor("debugger").apply("stateObject");
        }
        _0xdebug(0);
        console.log("keep");
      `);
      expect(result).not.toContain("_0xdebug");
      expect(result).toContain("keep");
    });

    it("removes unreferenced a0_0x-prefixed variables", () => {
      const result = ad(`
        function a0_0xdebug(x) {
          (function(){}).constructor("debugger").apply("stateObject");
        }
        a0_0xdebug(0);
        console.log("keep");
      `);
      expect(result).not.toContain("a0_0xdebug");
      expect(result).toContain("keep");
    });

    it("removes unreferenced a0_0x factory IIFE after guard removal", () => {
      const result = ad(`
        const a0_0x54b02b = function() {
          let firstCall = true;
          return function(context, fn) {
            const rfn = firstCall ? function() {
              if (fn) { const res = fn.apply(context, arguments); fn = null; return res; }
            } : function() {};
            firstCall = false;
            return rfn;
          };
        }();
        var a0_0x16b712 = a0_0x54b02b(this, function() {
          return a0_0x16b712.toString().search("(((.+)+)+)+$")
            .toString().constructor(a0_0x16b712).search("(((.+)+)+)+$");
        });
        a0_0x16b712();
        console.log("keep");
      `);
      expect(result).not.toContain("a0_0x54b02b");
      expect(result).not.toContain("a0_0x16b712");
      expect(result).not.toContain("firstCall");
      expect(result).toContain("keep");
    });

    it("preserves non-obfuscated unreferenced functions", () => {
      const result = ad(`
        function myHelper() { return 42; }
        console.log("keep");
      `);
      expect(result).toContain("myHelper");
      expect(result).toContain("keep");
    });
  });

  describe("RC1: business-logic functions with injected constructor traps", () => {
    it("preserves Main when constructor traps are in nested function expressions", () => {
      // C77-0 pattern: debug-protection injects constructor traps inside dead-code branches
      // of nested function expressions within Main. Main itself has business logic.
      const result = ad(`
        function Main(_0x1e2a2c) {
          const _0x58905c = function () {
            let _0x1eb39d = true;
            return function (_0xe64e4a, _0x5c2830) {
              const _0x1a6e2a = _0x1eb39d ? function () {
                if (_0x5c2830) {
                  if ("ZmnoL" !== "jzayM") {
                    const _0x544a90 = _0x5c2830["apply"](_0xe64e4a, arguments);
                    _0x5c2830 = null;
                    return _0x544a90;
                  } else {
                    return function (_0x3ec40b) {}["constructor"]("while (true) {}")["apply"]("counter");
                  }
                }
              } : function () {};
              _0x1eb39d = false;
              return _0x1a6e2a;
            };
          }();
          console["log"]("APPROVED");
        }
        Main("test");
      `);
      // Main must survive — it has business logic
      expect(result).toContain("APPROVED");
      expect(result).toContain("Main");
    });

    it("still removes dedicated anti-debug functions with nested FunctionDeclarations", () => {
      // _0x565abf is purely anti-debug: contains only a helper FunctionDeclaration + try/catch
      const result = ad(`
        function _0x565abf(_0x5482fb) {
          function _0x42a16e(_0xde2075) {
            if (typeof _0xde2075 === "string") {
              return function (_0x1c7ac9) {}["constructor"]("while (true) {}")["apply"]("counter");
            } else {
              (function () {
                return true;
              })["constructor"]("debugger")["call"]('action');
            }
            _0x42a16e(++_0xde2075);
          }
          try {
            if (_0x5482fb) {
              return _0x42a16e;
            } else {
              _0x42a16e(0);
            }
          } catch (_0x21ec77) {}
        }
        _0x565abf("init");
        console.log("keep");
      `);
      expect(result).not.toContain("_0x565abf");
      expect(result).not.toContain("_0x42a16e");
      expect(result).toContain("keep");
    });

    it("handles split 'debu' + 'gger' pattern in dedicated anti-debug functions", () => {
      const result = ad(`
        function _0xdebugHelper() {
          (function(){return true})["constructor"]("debu" + "gger")["call"]("action");
        }
        _0xdebugHelper();
        console.log("keep");
      `);
      expect(result).not.toContain("_0xdebugHelper");
      expect(result).toContain("keep");
    });
  });

  describe("RC2: self-defending init/chain/input pattern", () => {
    it("removes self-defending guard with init/chain/input strings", () => {
      const result = ad(`
        var _0x1234 = _0xfactory(this, function() {
          var _0x5678 = new RegExp("function *\\\\( *\\\\)");
          var _0xabcd = new RegExp("\\\\+\\\\+ *(?:[a-zA-Z_$][0-9a-zA-Z_$]*)", "i");
          var _0xresult = _0xcheck("init");
          if (!_0x5678.test(_0xresult + "chain") || !_0xabcd.test(_0xresult + "input")) {
            _0xresult("0");
          } else {
            _0xcheck();
          }
        });
        _0x1234();
        console.log("keep");
      `);
      expect(result).not.toContain("_0x1234");
      expect(result).toContain("keep");
    });

    it("removes init/chain/input guard declared in multi-level factory", () => {
      // Pattern where init/chain/input is in a nested callback
      const result = ad(`
        var _0xguard = someFactory(this, function() {
          var fn = _0xhelper("init");
          if (!new RegExp("function *\\\\( *\\\\)").test(fn + "chain") ||
              !new RegExp("\\\\+\\\\+").test(fn + "input")) {
            fn("0");
          } else {
            _0xhelper();
          }
        });
        _0xguard();
        console.log("keep");
      `);
      expect(result).not.toContain("_0xguard");
      expect(result).toContain("keep");
    });
  });
});
