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

  describe("R1: standalone IIFE with anti-debug patterns", () => {
    it("removes standalone IIFE containing init/chain/input directly", () => {
      const result = ad(`
        (function() {
          var _0x1234 = _0xfn("init");
          if (!new RegExp("function *\\\\( *\\\\)").test(_0x1234 + "chain") ||
              !new RegExp("\\\\+\\\\+").test(_0x1234 + "input")) {
            _0x1234("0");
          }
        })();
        console.log("keep");
      `);
      expect(result).not.toContain("init");
      expect(result).not.toContain("chain");
      expect(result).not.toContain("input");
      expect(result).toContain("keep");
    });

    it("removes two-part wrapper+IIFE with init/chain/input (C77-0 pattern)", () => {
      // Part 1: wrapper factory (once-caller)
      // Part 2: standalone IIFE calling wrapper(this, fn) where fn has init/chain/input
      const result = ad(`
        var _0x54b02b = function() {
          var _0xd4b0bb = true;
          return function(_0x3bd3f8, _0x103969) {
            var _0x37db5f = _0xd4b0bb ? function() {
              if (_0x103969) {
                var _0x590205 = _0x103969.apply(_0x3bd3f8, arguments);
                _0x103969 = null;
                return _0x590205;
              }
            } : function() {};
            _0xd4b0bb = false;
            return _0x37db5f;
          };
        }();
        (function() {
          _0x54b02b(this, function() {
            var _0x448915 = new RegExp("function *\\\\( *\\\\)");
            var _0x2e1212 = new RegExp("\\\\+\\\\+ *(?:[a-zA-Z_$][0-9a-zA-Z_$]*)", "i");
            var _0x293df7 = _0x25c477("init");
            if (!_0x448915.test(_0x293df7 + "chain") || !_0x2e1212.test(_0x293df7 + "input")) {
              _0x293df7("0");
            }
          })();
        })();
        console.log("keep");
      `);
      expect(result).not.toContain("init");
      expect(result).not.toContain("chain");
      expect(result).not.toContain("input");
      expect(result).not.toContain("_0x54b02b");
      expect(result).toContain("keep");
    });

    it("removes standalone IIFE with (((.+)+)+)+$ regex", () => {
      const result = ad(`
        (function() {
          return _0x1234.toString().search("(((.+)+)+)+$")
            .toString().constructor(_0x1234).search("(((.+)+)+)+$");
        })();
        console.log("keep");
      `);
      expect(result).not.toContain("(((.+)+)+)+$");
      expect(result).toContain("keep");
    });

    it("removes standalone IIFE with console override", () => {
      const result = ad(`
        (function() {
          var methods = ["log", "warn", "info", "error", "exception", "table", "trace"];
          for (var i = 0; i < methods.length; i++) {
            console[methods[i]] = function() {};
          }
        })();
        console.log("keep");
      `);
      expect(result).not.toContain("exception");
      expect(result).toContain("keep");
    });

    it("preserves standalone IIFE without anti-debug patterns", () => {
      const result = ad(`
        (function() {
          console.log("business logic");
        })();
        console.log("keep");
      `);
      expect(result).toContain("business logic");
      expect(result).toContain("keep");
    });

    it("preserves business logic after removing two-part anti-debug", () => {
      const result = ad(`
        var _0x54b02b = function() {
          var _0xd4b0bb = true;
          return function(_0x3bd3f8, _0x103969) {
            var _0x37db5f = _0xd4b0bb ? function() {
              if (_0x103969) {
                var _0x590205 = _0x103969.apply(_0x3bd3f8, arguments);
                _0x103969 = null;
                return _0x590205;
              }
            } : function() {};
            _0xd4b0bb = false;
            return _0x37db5f;
          };
        }();
        (function() {
          _0x54b02b(this, function() {
            var _0x293df7 = _0x25c477("init");
            if (!new RegExp("function *\\\\( *\\\\)").test(_0x293df7 + "chain") ||
                !new RegExp("\\\\+\\\\+").test(_0x293df7 + "input")) {
              _0x293df7("0");
            }
          })();
        })();
        var x = 42;
        console.log(x);
      `);
      expect(result).not.toContain("init");
      expect(result).not.toContain("_0x54b02b");
      expect(result).toContain("42");
      expect(result).toContain("console.log");
    });
  });

  describe("RC3: business-logic functions with dead-code-injected nested FunctionDeclaration traps", () => {
    it("preserves business-logic function when constructor trap is in nested FunctionDeclaration", () => {
      // C77-0 deadcode-injection pattern: a nested FunctionDeclaration inside a business
      // logic function contains .constructor("debugger"). The outer function must survive.
      const result = ad(`
        function BFS(x) {
          var queue = [[x, 0]];
          function _0xhelper(_0xarg) {
            if (typeof _0xarg === "string") {
              return function() {}["constructor"]("while (true) {}")["apply"]("counter");
            } else {
              (function() { return true; })["constructor"]("debugger")["call"]("action");
            }
            _0xhelper(++_0xarg);
          }
          while (queue.length > 0) {
            var item = queue.shift();
            if (item[0] === "done") return item[1];
          }
          return -1;
        }
        BFS("start");
      `);
      // BFS must survive — it contains business logic (queue, while loop)
      expect(result).toContain("BFS");
      expect(result).toContain("queue");
    });

    it("preserves main function with nested FunctionDeclaration containing constructor trap", () => {
      const result = ad(`
        function main(_0x1234) {
          function _0xdebugTrap(_0xarg) {
            (function(){})["constructor"]("debugger")["apply"]("stateObject");
          }
          var lines = _0x1234.split("\\n");
          console.log(lines[0]);
        }
        main("hello\\nworld");
      `);
      expect(result).toContain("main");
      expect(result).toContain("lines");
      expect(result).toContain("console.log");
    });
  });

  describe("RC4: dead-code-injected anti-debug patterns in nested functions", () => {
    it("preserves callback with init/chain/input injected inside nested function dead branch", () => {
      // Dead-code injection injects anti-debug strings ("init", "chain", "input")
      // into dead branches of business-logic functions. The shallow anti-debug detection
      // must NOT recurse into nested functions.
      const result = ad(`
        process.stdin.on("data", function (_0x4fdcc9) {
          var _0x4bf796 = _0x4fdcc9.trim().split("\\n");
          function _0x2236e2(_0x2d1d50) {
            var _0x2681a3 = { 'cFZRs': "init", 'LkmGC': "input" };
            if ("SPnyp" !== "WgkDE") {
              var _0x2891e7 = _0x2d1d50.split(" ");
              return parseInt(_0x2891e7[0]) + parseInt(_0x2891e7[1]);
            } else {
              var _0x29af67 = _0x29bf59(_0x2681a3["cFZRs"]);
              if (!_0x5c2bec.test(_0x29af67 + "chain")) { _0x29af67("0"); }
            }
          }
          console.log(_0x4bf796.map(_0x2236e2).join("\\n"));
        });
      `);
      expect(result).toContain("process.stdin.on");
      expect(result).toContain("parseInt");
      expect(result).toContain("console.log");
    });

    it("preserves method call with anti-debug patterns in nested function argument", () => {
      // Even if a callback argument has anti-debug strings deep inside nested functions,
      // the outer call (e.g., .on(), .forEach()) should not be removed.
      const result = ad(`
        arr.forEach(function(_0xitem) {
          function _0xprocess(_0xval) {
            var _0xobj = { 'key': "init" };
            if (true) {
              return _0xval * 2;
            } else {
              var _0xfn = _0xhelper(_0xobj["key"]);
              _0xfn.test(_0xfn + "chain");
              _0xfn.test(_0xfn + "input");
            }
          }
          console.log(_0xprocess(_0xitem));
        });
      `);
      expect(result).toContain("arr.forEach");
      expect(result).toContain("_0xval * 2");
    });
  });

  describe("RC5: preserve side effects when removing unreferenced _0x variables", () => {
    it("preserves .shift() call when variable result is unused", () => {
      // Phase 4 removes unreferenced _0x-named variables. But when the initializer
      // has side effects (like .shift() which modifies the array), the side effect
      // must be preserved as an ExpressionStatement.
      const result = ad(`
        function _0xdebug(x) {
          (function(){}).constructor("debugger").apply("stateObject");
        }
        _0xdebug();
        'use strict';
        const main = _0x521f13 => {
          const _0x48f361 = _0x521f13.trim().split("\\n");
          const _0x150879 = _0x48f361["shift"]();
          _0x48f361.forEach(_0x249e7c => {
            console.log(_0x249e7c);
          });
        };
        main(require('fs').readFileSync("/dev/stdin", "utf8"));
      `);
      // Anti-debug patterns should be removed
      expect(result).not.toContain("debugger");
      // The .shift() call must survive (as expression statement) — it modifies the array
      expect(result).toContain("shift");
      // Business logic must survive
      expect(result).toContain("forEach");
      expect(result).toContain("console.log");
    });

    it("preserves Number(arr.shift()) when wrapping variable is unused", () => {
      // _0x13a7e6 is never referenced, but Number(_0x1cdbd9["shift"]()) contains
      // a .shift() side effect that must survive.
      const result = ad(`
        function _0xdebug(x) {
          (function(){}).constructor("debugger").apply("stateObject");
        }
        _0xdebug();
        const main = _0x521f13 => {
          const _0x1cdbd9 = _0x521f13.trim().split("\\n");
          const _0x13a7e6 = Number(_0x1cdbd9["shift"]());
          _0x1cdbd9.forEach(x => console.log(x));
        };
        main(require('fs').readFileSync("/dev/stdin", "utf8"));
      `);
      expect(result).not.toContain("debugger");
      // The shift() call must survive even though _0x13a7e6 is unused
      expect(result).toContain("shift");
      expect(result).toContain("forEach");
    });

    it("still removes unreferenced _0x variables without side effects", () => {
      const result = ad(`
        function _0xdebug(x) {
          (function(){}).constructor("debugger").apply("stateObject");
        }
        _0xdebug();
        const _0xabcdef = 42;
        console.log("keep");
      `);
      expect(result).not.toContain("debugger");
      expect(result).not.toContain("_0xabcdef");
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
