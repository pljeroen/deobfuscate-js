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
});
