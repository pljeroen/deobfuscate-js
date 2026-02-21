/**
 * HARDEN-05: Fix remaining 10 benchmark failures + proactive hardening.
 *
 * H05: anti-debug removes entire program IIFE when only 1 of N stmts references removed name
 * H06: anti-debug Phase 4 VariableDeclarator missing for-in/for-of guard
 * H07: semantic-rename var hoisting scope collision
 * H08: string-array single-param wrapper detection
 * H09: sandbox preamble missing setTimeout/setInterval stubs
 */
import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline.js";
import { antiDebugPass } from "../src/passes/anti-debug.js";
import { semanticRenamePass } from "../src/passes/semantic-rename.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { formatPass } from "../src/passes/format.js";
import { executeSandboxed } from "../src/sandbox.js";

describe("H05: anti-debug preserves business logic in mixed IIFEs", () => {
  it("preserves business logic when IIFE has 5 stmts but only 1 is anti-debug", () => {
    // Reproduces debug-protection benchmark failures (p02233_1, p00023_1, etc.)
    // Pattern: outer IIFE wraps entire program, contains anti-debug factory + business logic
    const code = `
      function _0x4b3359(ret) {
        function debuggerProtection(counter) {
          counter['constructor']("debugger")['apply']("stateObject");
        }
        debuggerProtection(this);
      }
      (function() {
        var _0x55b044 = (function() {
          var firstCall = true;
          return function(context, fn) {
            var rfn = firstCall ? function() { if (fn) { var r = fn.apply(context, arguments); fn = null; return r; } } : function() {};
            firstCall = false;
            return rfn;
          };
        }());
        var setup = _0x55b044(this, function() { _0x4b3359('init'); });
        setup();
        var n = 10;
        var result = n * n;
        console.log(result);
      }());
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    // Business logic must survive
    expect(result).toContain("console");
    expect(result).toContain("result");
    // The constructor trap function should be removed
    expect(result).not.toContain("debuggerProtection");
  });

  it("preserves business logic in 3-statement mixed IIFE", () => {
    // Minimal reproduction: 3 statements, only 1 references removed name
    const code = `
      function _0xdebug() {
        (function() {})['constructor']("while (true) {}")['apply']("counter");
      }
      (function() {
        _0xdebug();
        var x = 42;
        console.log(x);
      }());
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    expect(result).toContain("console");
    expect(result).toContain("42");
  });

  it("still removes pure anti-debug IIFEs where all statements are anti-debug", () => {
    // IIFE body is ONLY anti-debug wiring — safe to remove entirely
    const code = `
      function _0xdebug() {
        (function() {})['constructor']("debugger")['apply']("counter");
      }
      (function() {
        _0xdebug();
      }());
      console.log("real code");
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    expect(result).toContain("console");
    expect(result).not.toContain("_0xdebug");
  });

  it("handles nested anti-debug wiring inside outer IIFE with business logic", () => {
    // Pattern: outer IIFE has inner IIFE calling factory + business logic
    const code = `
      function _0xcheck() {
        (function() {})['constructor']("while (true) {}")();
      }
      (function() {
        (function() { _0xcheck(); })();
        var arr = [1, 2, 3];
        for (var i = 0; i < arr.length; i++) {
          arr[i] = arr[i] * 2;
        }
        console.log(arr);
      }());
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    expect(result).toContain("console");
    expect(result).toContain("arr");
  });
});

describe("H06: anti-debug Phase 4 for-in/for-of guard", () => {
  it("does not crash when removing unreferenced _0x var used as for-in LHS", () => {
    // Reproduces p02573_1: for(let _0x1a in obj) { count++; }
    // Phase 4 tries to remove unreferenced _0x names — but for-in LHS is structural
    const code = `
      function countKeys(obj) {
        let count = 0;
        for (let _0x1a2b in obj) {
          count++;
        }
        return count;
      }
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    expect(result).toContain("for");
    expect(result).toContain("in");
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("does not crash when removing unreferenced _0x var used as for-of LHS", () => {
    const code = `
      function sumItems(arr) {
        let total = 0;
        for (let _0x3c4d of arr) {
          total++;
        }
        return total;
      }
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    expect(result).toContain("for");
    expect(result).toContain("of");
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("still removes unreferenced _0x vars that are not for-in/for-of LHS", () => {
    const code = `
      function test() {
        var _0xdead = 42;
        return 1;
      }
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    expect(result).not.toContain("_0xdead");
  });
});

describe("H07: semantic-rename var hoisting scope collision", () => {
  it("does not rename var inside for-loop to collide with outer scope name", () => {
    // Reproduces p02983_1, p03048_1: var declarations hoist to function scope
    // When _0x1111 gets renamed to "num" and _0x3333 is also arithmetic,
    // tryAssignCandidate must see "num" is taken at the function scope level
    const code = `
      function solve() {
        var _0x1111 = 0;
        _0x1111 += 10;
        _0x1111 *= 3;
        for (var _0x2222 = 0; _0x2222 < 10; _0x2222++) {
          var _0x3333 = 0;
          _0x3333 += _0x2222;
          _0x3333 *= 2;
          console.log(_0x3333);
        }
        console.log(_0x1111);
      }
    `;
    const result = runPipeline(code, [semanticRenamePass], [formatPass]);
    // Both _0x1111 and _0x3333 match arithmetic — they must NOT both become "num"
    // Count occurrences of "var num" declarations
    const numDeclCount = (result.match(/\b(var|let|const)\s+num\b/g) || []).length;
    expect(numDeclCount).toBeLessThanOrEqual(1);
    // Must produce valid code
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("handles var inside nested block still checking function scope", () => {
    const code = `
      function calc() {
        let _0xaaaa = 0;
        _0xaaaa += 10;
        _0xaaaa *= 3;
        if (true) {
          var _0xbbbb = 0;
          _0xbbbb += 5;
          _0xbbbb *= 2;
        }
        return _0xaaaa + _0xbbbb;
      }
    `;
    const result = runPipeline(code, [semanticRenamePass], [formatPass]);
    // var _0xbbbb hoists to function scope — must not collide with _0xaaaa's rename
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("does not collide const num with var in for-loop across iterations", () => {
    // Reproduces p02983_1 and p03048_1 exactly: const gets "num" in iteration 1,
    // then var in for-loop gets "num" in iteration 2 because ForStatement scope
    // has no bindings — the function scope where "num" lives is not checked.
    const code = `
      function Main(_0x15441f) {
        const _0x4e3534 = Number['parseInt'](_0x15441f[0]);
        const _0x4df664 = Number['parseInt'](_0x15441f[1]);
        _0x4e3534 + _0x4df664;
        _0x4e3534 * 2;
        _0x4df664 * 3;
        var _0x2ad6b5 = 100;
        for (var _0x51949f = _0x4e3534; _0x51949f < _0x4df664; _0x51949f++) {
          for (var _0x1a8983 = _0x51949f + 1; _0x1a8983 < _0x4df664 + 1; _0x1a8983++) {
            _0x2ad6b5 += _0x51949f;
            _0x2ad6b5 *= _0x1a8983;
          }
        }
        console.log(_0x2ad6b5);
      }
    `;
    // Run through the full pipeline (3 iterations) to trigger cross-iteration collision
    const result = runPipeline(code, [semanticRenamePass], [formatPass]);
    // Must produce valid code — no duplicate "num" across const and var
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("does not collide let/const with same candidate name across scopes", () => {
    const code = `
      function outer() {
        const _0x1111 = [1, 2];
        _0x1111.push(3);
        _0x1111.forEach(function() {});
        {
          const _0x2222 = [4, 5];
          _0x2222.push(6);
          _0x2222.forEach(function() {});
          console.log(_0x2222);
        }
        console.log(_0x1111);
      }
    `;
    const result = runPipeline(code, [semanticRenamePass], [formatPass]);
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });
});

describe("H08: string-array single-param wrapper detection", () => {
  it("detects wrapper function with exactly 1 parameter", async () => {
    // Proactive: javascript-obfuscator can emit 1-param wrappers
    // The pipeline should still detect and resolve them
    const { stringArrayPass } = await import("../src/passes/string-array.js");
    const code = `
      var _0xarr = ["hello", "world", "test"];
      function _0xdec(idx) {
        return _0xarr[idx];
      }
      function _0xwrap(a) {
        return _0xdec(a - 1);
      }
      console.log(_0xwrap(1), _0xwrap(2));
    `;
    const result = runPipeline(code, [stringArrayPass], [formatPass]);
    // If wrapper detected: _0xwrap calls replaced with strings
    // If not detected: _0xwrap still in output as function calls
    expect(result).not.toContain("_0xwrap");
  });
});

describe("H09: sandbox setTimeout/setInterval stubs", () => {
  it("does not throw ReferenceError for setTimeout in sandbox", () => {
    const code = `
      setTimeout(function() {}, 1000);
      process.stdout.write("__DEOBF_JSON_START__" + JSON.stringify({ok: "yes"}));
    `;
    const output = executeSandboxed(code, 5000);
    expect(output).toContain("__DEOBF_JSON_START__");
    expect(output).toContain('"ok":"yes"');
  });

  it("does not throw ReferenceError for setInterval in sandbox", () => {
    const code = `
      var id = setInterval(function() {}, 500);
      clearInterval(id);
      process.stdout.write("__DEOBF_JSON_START__" + JSON.stringify({ok: "yes"}));
    `;
    const output = executeSandboxed(code, 5000);
    expect(output).toContain("__DEOBF_JSON_START__");
  });

  it("does not throw ReferenceError for clearTimeout in sandbox", () => {
    const code = `
      var id = setTimeout(function() {}, 100);
      clearTimeout(id);
      process.stdout.write("__DEOBF_JSON_START__" + JSON.stringify({ok: "yes"}));
    `;
    const output = executeSandboxed(code, 5000);
    expect(output).toContain("__DEOBF_JSON_START__");
  });
});
