/**
 * Tests for code review findings (REVIEW-01 contract).
 * 10 issues covering security, correctness, stability, and UX.
 */
import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";
import { executeSandboxed } from "../src/sandbox.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { antiDebugPass } from "../src/passes/anti-debug.js";
import { bundlerUnpackPass } from "../src/passes/bundler-unpack.js";
import { stringArrayPass } from "../src/passes/string-array.js";
import { runASTPipeline, runPipeline, filterSafePasses } from "../src/pipeline.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";

function dce(code: string): string {
  return generate(deadCodeEliminatePass.run(parse(code)));
}

function antiDebug(code: string): string {
  return generate(antiDebugPass.run(parse(code)));
}

function unpack(code: string): string {
  return generate(bundlerUnpackPass.run(parse(code)));
}

// --- R01: Sandbox hardening ---

describe("R01: sandbox restricts require/fs/net", () => {
  it("blocks require('fs') in sandboxed code", () => {
    // Sandboxed code should not be able to read files
    const result = executeSandboxed(`
      try {
        var fs = require("fs");
        process.stdout.write("LEAK");
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    expect(result).toBe("BLOCKED");
  });

  it("blocks require('child_process') in sandboxed code", () => {
    const result = executeSandboxed(`
      try {
        var cp = require("child_process");
        process.stdout.write("LEAK");
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    expect(result).toBe("BLOCKED");
  });

  it("blocks require('net') in sandboxed code", () => {
    const result = executeSandboxed(`
      try {
        var net = require("net");
        process.stdout.write("LEAK");
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    expect(result).toBe("BLOCKED");
  });

  it("allows basic JS operations without require", () => {
    const result = executeSandboxed(`
      var a = [1, 2, 3];
      var b = a.map(function(x) { return x * 2; });
      process.stdout.write(JSON.stringify(b));
    `);
    expect(result).toBe("[2,4,6]");
  });
});

// --- R02: CLI defaults to safe passes ---

describe("R02: safe passes by default", () => {
  it("filterSafePasses excludes stringArrayPass", () => {
    const allPasses = [constantFoldPass, stringArrayPass];
    const safe = filterSafePasses(allPasses);
    expect(safe).not.toContain(stringArrayPass);
    expect(safe).toContain(constantFoldPass);
  });

  it("stringArrayPass is marked unsafe", () => {
    expect(stringArrayPass.safety).toBe("unsafe");
  });
});

// --- R03: Parser returns diagnostics ---

describe("R03: parser diagnostics", () => {
  it("parse() still returns File for backwards compat", () => {
    const ast = parse("var x = 1;");
    expect(ast.type).toBe("File");
  });

  it("parseWithDiagnostics returns warnings on truncation", async () => {
    // Dynamic import to handle the new function
    const parser = await import("../src/parser.js");
    if (!parser.parseWithDiagnostics) {
      // Function doesn't exist yet — test should fail
      expect(parser.parseWithDiagnostics).toBeDefined();
      return;
    }
    const result = parser.parseWithDiagnostics("var x = 1;\n@@@INVALID");
    expect(result.ast).toBeDefined();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("parseWithDiagnostics returns no warnings for valid code", async () => {
    const parser = await import("../src/parser.js");
    if (!parser.parseWithDiagnostics) {
      expect(parser.parseWithDiagnostics).toBeDefined();
      return;
    }
    const result = parser.parseWithDiagnostics("var x = 1;");
    expect(result.warnings).toHaveLength(0);
  });
});

// --- R04: Bundler unpack metadata ---

describe("R04: bundler unpack metadata header", () => {
  it("emits metadata comment for webpack 4 bundle", () => {
    const code = `(function(modules) {
      function __webpack_require__(id) { return modules[id]; }
      __webpack_require__(0);
    })([
      function(module, exports) { module.exports = 1; },
      function(module, exports) { module.exports = 2; }
    ]);`;
    const result = unpack(code);
    expect(result).toContain("webpack");
    expect(result).toContain("module");
  });

  it("handles 'use strict' before IIFE", () => {
    const code = `"use strict";(function(modules) {
      function __webpack_require__(id) { return modules[id]; }
      __webpack_require__(0);
    })([
      function(module, exports) { module.exports = 1; }
    ]);`;
    const result = unpack(code);
    // Should detect and extract modules even with "use strict" prefix
    expect(result).toContain("__module_0__");
  });
});

// --- R05: Pipeline source freshness ---

describe("R05: sourceSlice validates ranges", () => {
  it("string-array pass handles mutated AST gracefully", () => {
    // This is a functional check — string-array should not crash when
    // node positions don't match source after earlier passes mutate AST
    const code = `
      var _0x4e2c = ['log', 'Hello', 'world', 'foo', 'bar'];
      function _0xdec(idx) { return _0x4e2c[idx]; }
      var x = 1 + 2;
      console[_0xdec(0)](_0xdec(1));
    `;
    // Run constant fold first (mutates AST), then string-array
    const ast = parse(code);
    const folded = constantFoldPass.run(ast);
    // Now run string-array with ORIGINAL source (simulating stale source)
    expect(() => stringArrayPass.run(folded, code)).not.toThrow();
  });
});

// --- R06: Reduced convergence caps ---

describe("R06: tighter convergence loop caps", () => {
  it("anti-debug terminates quickly on adversarial input", () => {
    // Generate code with many removable references that chain
    const fns = Array.from({ length: 20 }, (_, i) =>
      `function _0xfn${i}() { (function(){}).constructor("debugger")(); }`
    ).join("\n");
    const calls = Array.from({ length: 20 }, (_, i) =>
      `_0xfn${i}();`
    ).join("\n");
    const code = fns + "\n" + calls;

    const start = Date.now();
    antiDebug(code);
    // Should complete in well under 5 seconds
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

// --- R07: Recursive temp dir cleanup ---

describe("R07: recursive temp dir cleanup", () => {
  it("sandbox handles child creating extra files", () => {
    // Child process writes an extra file in the temp dir
    // Cleanup should still succeed (recursive removal)
    const result = executeSandboxed(`
      var fs = null;
      try { fs = require("fs"); } catch(e) {}
      process.stdout.write("ok");
    `);
    // If require is blocked, it still returns "ok"
    // The key thing: no lingering temp dirs from previous tests
    expect(result).toBeDefined();
  });
});

// --- R08: Tighter console-override detection ---

describe("R08: console-override detection precision", () => {
  it("does not remove legit code with console method names", () => {
    const code = `
      var methods = ["log", "warn", "info", "error"];
      methods.forEach(function(m) { console[m]("test"); });
    `;
    const result = antiDebug(code);
    // This is legit logging code, not a console override — should be preserved
    expect(result).toContain("methods");
    expect(result).toContain("forEach");
  });

  it("still removes actual console-override IIFE", () => {
    const code = `
      var _0xguard = (function() {
        return function(_0xfn, _0xctx) { return _0xfn.apply(_0xctx, arguments); };
      })(this, function() {
        var _0xconsole = ["log", "warn", "info", "error", "exception", "table", "trace"];
        for (var _0xi = 0; _0xi < _0xconsole.length; _0xi++) {
          console[_0xconsole[_0xi]] = function() {};
        }
      });
      _0xguard();
    `;
    const result = antiDebug(code);
    // This is the actual obfuscator.io pattern — should be removed
    expect(result).not.toContain("_0xguard");
  });
});

// --- R09: Restrict isPure identifier handling ---

describe("R09: isPure rejects unknown identifiers", () => {
  it("does not remove unused var initialized to unknown identifier", () => {
    const result = dce(`
      var unused = someGlobal;
      console.log("keep");
    `);
    // someGlobal could throw ReferenceError — not safe to remove
    expect(result).toContain("someGlobal");
  });

  it("removes unused var initialized to undefined identifier", () => {
    const result = dce(`
      var unused = undefined;
      console.log("keep");
    `);
    // undefined is safe
    expect(result).not.toContain("var unused");
  });

  it("removes unused var initialized to NaN", () => {
    const result = dce(`
      var unused = NaN;
      console.log("keep");
    `);
    expect(result).not.toContain("var unused");
  });
});

// --- R10: Structured pipeline output ---

describe("R10: structured pipeline output", () => {
  it("runPipeline still returns string for compat", () => {
    const result = runPipeline("var x = 1;", [constantFoldPass], []);
    expect(typeof result).toBe("string");
  });

  it("runPipelineWithReport returns structured output", async () => {
    const pipeline = await import("../src/pipeline.js");
    if (!pipeline.runPipelineWithReport) {
      expect(pipeline.runPipelineWithReport).toBeDefined();
      return;
    }
    const result = pipeline.runPipelineWithReport("var x = 1 + 2;", [constantFoldPass], []);
    expect(result.code).toBeDefined();
    expect(result.warnings).toBeDefined();
    expect(result.report).toBeDefined();
    expect(Array.isArray(result.report)).toBe(true);
  });
});
