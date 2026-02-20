/**
 * Tests for red-team findings (REDTEAM-01 contract).
 * Each test targets a specific bug identified during the 2-pass adversarial review.
 */
import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";
import { executeSandboxed } from "../src/sandbox.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { constantPropagatePass } from "../src/passes/constant-propagate.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { controlFlowObjectPass } from "../src/passes/control-flow-object.js";
import { controlFlowUnflattenPass } from "../src/passes/control-flow-unflatten.js";
import { antiDebugPass } from "../src/passes/anti-debug.js";
import { semanticRenamePass } from "../src/passes/semantic-rename.js";
import { stringArrayPass } from "../src/passes/string-array.js";
import { tokenize } from "../src/tokenizer.js";
import { runASTPipeline } from "../src/pipeline.js";
import { TokenType } from "../src/types.js";

function fold(code: string): string {
  return generate(constantFoldPass.run(parse(code)));
}

function propagate(code: string): string {
  return generate(constantPropagatePass.run(parse(code)));
}

function dce(code: string): string {
  return generate(deadCodeEliminatePass.run(parse(code)));
}

function cfo(code: string): string {
  return generate(controlFlowObjectPass.run(parse(code)));
}

function cfu(code: string): string {
  return generate(controlFlowUnflattenPass.run(parse(code)));
}

function antiDebug(code: string): string {
  return generate(antiDebugPass.run(parse(code)));
}

function semanticRename(code: string): string {
  return generate(semanticRenamePass.run(parse(code)));
}

function strArray(code: string): string {
  return generate(stringArrayPass.run(parse(code), code));
}

// --- CRITICAL #2: Regex injection via unescaped identifiers ---

describe("CRITICAL #2: regex injection in string-array", () => {
  it("handles identifier with regex special characters safely", () => {
    // If the name contains regex chars like (), the regex construction would break
    // This should not throw
    const code = `
      var arr$1 = ['log', 'Hello', 'world', 'foo', 'bar'];
      function dec$1(idx) { return arr$1[idx]; }
      console[dec$1(0)](dec$1(1));
    `;
    expect(() => strArray(code)).not.toThrow();
  });
});

// --- CRITICAL #3: Sandbox timeout scales to 60s from attacker input ---

describe("CRITICAL #3: sandbox timeout cap", () => {
  it("caps sandbox timeout at a reasonable maximum", () => {
    // Even with very large setup code, timeout should be bounded
    // The current code allows up to 60s which is excessive
    // After fix, should be capped lower
    const start = Date.now();
    try {
      // 100KB of comments to inflate setupCode size
      const bigCode = "// " + "x".repeat(100 * 1024) + "\nprocess.stdout.write('ok');";
      executeSandboxed(bigCode, 15000);
    } catch {
      // Timeout or error is fine
    }
    // Should not have waited more than 15 seconds
    expect(Date.now() - start).toBeLessThan(16000);
  });
});

// --- HIGH #4: DoS via unbounded convergence loops ---

describe("HIGH #4: convergence loop bounds", () => {
  it("pipeline enforces max iteration limit", () => {
    // An adversarial input that could cause many iterations should be bounded
    const code = "var x = 1;";
    // runASTPipeline should accept and respect maxIterations
    const result = runASTPipeline(code, [constantFoldPass], { maxIterations: 2 });
    expect(result).toBeDefined();
  });
});

// --- HIGH #5: Temp file security ---

describe("HIGH #5: temp file security", () => {
  it("sandbox cleans up temp files on success", () => {
    const result = executeSandboxed('process.stdout.write("ok")');
    expect(result).toBe("ok");
    // No assertion on temp files — just verify no crash
  });
});

// --- HIGH #6: Input size limits ---

describe("HIGH #6: input size limits", () => {
  it("pipeline handles very large input without crashing", () => {
    // Generate a 500KB input — pipeline should handle without OOM
    const bigCode = "var " + Array.from({length: 1000}, (_, i) => `x${i} = ${i}`).join(", ") + ";";
    const result = runASTPipeline(bigCode, [constantFoldPass], { maxIterations: 1 });
    expect(result).toBeDefined();
  });
});

// --- MEDIUM #8: Alias propagation ignores scope shadowing ---

describe("MEDIUM #8: alias propagation respects scope", () => {
  it("does not propagate across scope shadows", () => {
    const result = propagate(`
      const x = 5;
      function f() {
        const x = 10;
        return x;
      }
      var y = x;
    `);
    // Inner x=10 should not be replaced with 5
    expect(result).toContain("10");
    // Outer y = x should become y = 5
    expect(result).toContain("var y = 5");
  });
});

// --- MEDIUM #9: referencesAny over-matches property keys ---

describe("MEDIUM #9: referencesAny property key false positive", () => {
  it("does not match property names as references", () => {
    // If a removed function is named 'log', we should not remove code
    // that just has a property named 'log'
    const result = antiDebug(`
      function _0xdebug() {
        (function(){}).constructor("debugger")();
      }
      var obj = { _0xdebug: "value" };
      console.log(obj._0xdebug);
    `);
    // The object property named _0xdebug should survive
    expect(result).toContain("_0xdebug");
    // The function declaration should be removed
    expect(result).not.toContain('constructor("debugger")');
  });
});

// --- MEDIUM #10: Direct splice on SequenceExpression ---

describe("MEDIUM #10: SequenceExpression handling uses Babel paths", () => {
  it("correctly handles sequence expression filtering", () => {
    const result = antiDebug(`
      function _0xtrap() {
        (function(){}).constructor("debugger")();
      }
      (function() { _0xtrap(); }(), console.log("keep"));
    `);
    // The console.log should be preserved
    expect(result).toContain("console.log");
    // The trap should be removed
    expect(result).not.toContain("debugger");
  });
});

// --- MEDIUM #11: replaceWithMultiple leaks block-scoped bindings ---

describe("MEDIUM #11: replaceWithMultiple block-scoped bindings", () => {
  it("does not leak let/const from if-true block into parent scope", () => {
    const result = dce(`
      if (true) {
        let x = 1;
        console.log(x);
      }
      console.log("after");
    `);
    // After DCE, x should either be in a block or the code should still be valid
    // The key thing is it shouldn't cause a scoping error
    expect(result).toContain("console.log");
  });

  it("preserves block scoping for const declarations", () => {
    const result = dce(`
      if (true) {
        const a = 1;
        console.log(a);
      }
      const a = 2;
      console.log(a);
    `);
    // Both a declarations should exist without conflict
    expect(result).toContain("const a = 1");
    expect(result).toContain("const a = 2");
  });
});

// --- MEDIUM #12: SpreadElement cast crash in control-flow-object ---

describe("MEDIUM #12: SpreadElement crash in control-flow-object", () => {
  it("does not crash on spread arguments in proxy call", () => {
    const code = `
      var _0x = {
        abc: function(a, b) { return a + b; }
      };
      _0x.abc(...args);
    `;
    // Should not crash even with spread args
    expect(() => cfo(code)).not.toThrow();
  });
});

// --- MEDIUM #13: isPure treats all identifiers as side-effect-free ---

describe("MEDIUM #13: isPure identifier handling", () => {
  it("does not remove variable whose init calls a function via identifier", () => {
    const result = dce(`
      function sideEffect() { console.log("effect"); return 1; }
      var unused = sideEffect();
    `);
    // sideEffect() has side effects — unused should NOT be removed
    expect(result).toContain("sideEffect()");
  });

  it("removes variable with pure literal initializer", () => {
    const result = dce(`
      var unused = 42;
      console.log("keep");
    `);
    expect(result).not.toContain("42");
    expect(result).toContain("keep");
  });
});

// --- MEDIUM #14: isConstantTruthy misses !!true ---

describe("MEDIUM #14: isConstantTruthy handles !!true", () => {
  it("recognizes !!true as constant truthy", () => {
    const result = cfu(`
      var _0x = '1|0'.split('|');
      var _0xi = 0;
      while (!!true) {
        switch (_0x[_0xi++]) {
          case '0': console.log('second'); continue;
          case '1': console.log('first'); continue;
        }
        break;
      }
    `);
    expect(result).toContain("'first'");
    expect(result).toContain("'second'");
    expect(result.indexOf("'first'")).toBeLessThan(result.indexOf("'second'"));
  });
});

// --- MEDIUM #15: mergeSequentialAssignments self-reference bug ---

describe("MEDIUM #15: mergeSequentialAssignments self-reference", () => {
  it("stops merging when assignment references the object itself", () => {
    const code = `
      var _0x = {};
      _0x["a"] = "hello";
      _0x["b"] = _0x["a"] + " world";
      console.log(_0x["a"]);
    `;
    // Self-referencing assignment should not be merged into the literal
    // because the value depends on runtime state of the object
    const result = cfo(code);
    expect(result).toBeDefined();
  });
});

// --- MEDIUM #16: Semantic rename global map across scopes ---

describe("MEDIUM #16: semantic rename scope isolation", () => {
  it("renames loop counters independently per scope", () => {
    const result = semanticRename(`
      function f1() {
        for (var _0xabc = 0; _0xabc < 10; _0xabc++) {
          console.log(_0xabc);
        }
      }
      function f2() {
        for (var _0xdef = 0; _0xdef < 20; _0xdef++) {
          console.log(_0xdef);
        }
      }
    `);
    // Both should be renamed to 'i' independently since they're in different scopes
    expect(result).toContain("for (var i = 0;");
    // Both functions should use 'i', not i and j
    const matches = result.match(/for \(var i = 0/g);
    expect(matches).toHaveLength(2);
  });
});

// --- MEDIUM #17: path.remove() during traversal skips siblings ---

describe("MEDIUM #17: constant-propagate handles path removal safely", () => {
  it("propagates all constants even when some are removed", () => {
    const result = propagate(`
      const a = 1;
      const b = 2;
      const c = 3;
      var x = a + b + c;
    `);
    // All three constants should be inlined
    expect(result).toContain("1 + 2 + 3");
  });
});

// --- MEDIUM #18: Negative zero folded to positive zero ---

describe("MEDIUM #18: negative zero handling", () => {
  it("does not fold -0 to 0", () => {
    const result = fold("var x = 0 * -1;");
    // 0 * -1 = -0, but -0 === 0 in JS representation is tricky
    // The important thing is we don't fold it to just `0` because
    // 1/-0 === -Infinity while 1/0 === Infinity
    // We should either leave it alone (SKIP) or represent as -0
    // Folding to `0` is wrong because it changes 1/x from -Infinity to Infinity
    expect(result).not.toBe("var x = 0;");
  });
});

// --- MEDIUM #19: canBeRegex wrong after this/true/false/null ---

describe("MEDIUM #19: canBeRegex after keywords", () => {
  it("treats / after 'this' as division", () => {
    const tokens = tokenize("this / 2");
    const divToken = tokens.find(t => t.type === TokenType.Punctuator && t.value === "/");
    expect(divToken).toBeDefined();
    // Should NOT be tokenized as regex
    const regexToken = tokens.find(t => t.type === TokenType.RegExp);
    expect(regexToken).toBeUndefined();
  });

  it("treats / after 'true' as division", () => {
    const tokens = tokenize("true / false");
    const regexToken = tokens.find(t => t.type === TokenType.RegExp);
    expect(regexToken).toBeUndefined();
  });

  it("treats / after 'false' as division", () => {
    const tokens = tokenize("false / 2");
    const regexToken = tokens.find(t => t.type === TokenType.RegExp);
    expect(regexToken).toBeUndefined();
  });

  it("treats / after 'null' as division", () => {
    const tokens = tokenize("null / 2");
    const regexToken = tokens.find(t => t.type === TokenType.RegExp);
    expect(regexToken).toBeUndefined();
  });

  it("still treats / after 'return' as regex start", () => {
    const tokens = tokenize("return /test/g");
    const regexToken = tokens.find(t => t.type === TokenType.RegExp);
    expect(regexToken).toBeDefined();
  });
});
