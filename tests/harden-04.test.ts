/**
 * HARDEN-04: Pipeline hardening — fix benchmark failures and red-team edge cases.
 *
 * H01: semantic-rename duplicate declaration bug
 * H02: dead-code-eliminate for-in/for-of LHS removal
 * H03: tokenizer regex escape handling
 * H04: anti-debug stripping entire debug-protection programs
 */
import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline.js";
import { semanticRenamePass } from "../src/passes/semantic-rename.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { antiDebugPass } from "../src/passes/anti-debug.js";
import { formatPass } from "../src/passes/format.js";
import { tokenize } from "../src/tokenizer.js";
import { TokenType } from "../src/types.js";

describe("H01: semantic-rename duplicate declaration", () => {
  it("does not rename two array-usage variables to the same name in one scope", () => {
    // Reproduces benchmark failure: p02288_1 (name-obfuscation)
    const code = `
      function main() {
        const _0x1111 = require('fs').readFileSync('/dev/stdin', 'utf8').split('\\n');
        _0x1111.shift();
        const _0x2222 = _0x1111.shift().split(' ').map(Number);
        _0x2222.sort();
        console.log(_0x1111.length, _0x2222.length);
      }
    `;
    const result = runPipeline(code, [semanticRenamePass], [formatPass]);
    // Both _0x1111 and _0x2222 are array usage — they must get DIFFERENT names
    expect(result).not.toMatch(/const (arr|items|list) =.*\n.*const \1 =/s);
    // Must not produce duplicate declarations (parseable without error)
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("does not rename two arithmetic-usage variables to the same name in one scope", () => {
    const code = `
      function calc() {
        let _0xaaaa = 0;
        let _0xbbbb = 0;
        _0xaaaa += 5;
        _0xaaaa *= 2;
        _0xbbbb += 3;
        _0xbbbb *= 4;
        return _0xaaaa + _0xbbbb;
      }
    `;
    const result = runPipeline(code, [semanticRenamePass], [formatPass]);
    // Both match arithmetic pattern — must get different names
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("falls back to second candidate when first is taken in scope", () => {
    const code = `
      function process() {
        const _0x3333 = [1, 2, 3];
        _0x3333.push(4);
        _0x3333.forEach(function(_0x5555) {});
        const _0x4444 = [5, 6, 7];
        _0x4444.map(function(_0x6666) { return _0x6666; });
        console.log(_0x3333, _0x4444);
      }
    `;
    const result = runPipeline(code, [semanticRenamePass], [formatPass]);
    // One should be "arr", the other "items" or "list"
    const arrCount = (result.match(/\barr\b/g) || []).length;
    const itemsCount = (result.match(/\bitems\b/g) || []).length;
    const listCount = (result.match(/\blist\b/g) || []).length;
    // At least two different names should be used
    const usedNames = [arrCount > 0, itemsCount > 0, listCount > 0].filter(Boolean).length;
    expect(usedNames).toBeGreaterThanOrEqual(2);
  });

  it("handles three array variables in same scope without collision", () => {
    // Reproduces p03037_1 pattern — 3 array vars in one function
    const code = `
      function main(_0x1111) {
        const _0x2222 = _0x1111.split('\\n');
        const _0x3333 = _0x2222.shift().split(' ').map(Number);
        const _0x4444 = new Array(10).fill(true);
        _0x4444.forEach(function() {});
        console.log(_0x2222.length, _0x3333[0], _0x4444.filter(Boolean).length);
      }
    `;
    const result = runPipeline(code, [semanticRenamePass], [formatPass]);
    // Must produce valid code — no duplicate const declarations
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });
});

describe("H02: dead-code-eliminate for-in/for-of LHS", () => {
  it("preserves unreferenced for-in iteration variable", () => {
    // Reproduces p02573_1 — for(let t2 in obj){count++;}
    const code = `
      function countKeys(obj) {
        let count = 0;
        for (let key in obj) {
          count++;
        }
        return count;
      }
    `;
    const result = runPipeline(code, [deadCodeEliminatePass], [formatPass]);
    expect(result).toContain("for");
    expect(result).toContain("in");
    // The for-in loop must still be valid
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("preserves unreferenced for-of iteration variable", () => {
    const code = `
      function countItems(arr) {
        let count = 0;
        for (let item of arr) {
          count++;
        }
        return count;
      }
    `;
    const result = runPipeline(code, [deadCodeEliminatePass], [formatPass]);
    expect(result).toContain("for");
    expect(result).toContain("of");
    expect(() => runPipeline(result, [constantFoldPass], [])).not.toThrow();
  });

  it("still removes normal unused variable declarations", () => {
    const code = `
      function test() {
        var unused = 42;
        return 1;
      }
    `;
    const result = runPipeline(code, [deadCodeEliminatePass], [formatPass]);
    expect(result).not.toContain("unused");
  });
});

describe("H03: tokenizer regex escape handling", () => {
  it("tokenizes regex with escaped brackets correctly", () => {
    // Reproduces p00769_1 — /\[{2}\d.*?\]{2}/
    const code = String.raw`/\[{2}\d.*?\]{2}/`;
    const tokens = tokenize(code);
    const regexTokens = tokens.filter(t => t.type === TokenType.RegExp);
    expect(regexTokens).toHaveLength(1);
    expect(regexTokens[0].value).toBe(code);
  });

  it("tokenizes regex with escaped bracket followed by code", () => {
    const code = String.raw`if (/\[{2}\d.*?\]{2}/.test(str)) { count++; }`;
    const tokens = tokenize(code);
    const regexTokens = tokens.filter(t => t.type === TokenType.RegExp);
    expect(regexTokens).toHaveLength(1);
    // The regex should not swallow the surrounding code
    const braceTokens = tokens.filter(t => t.type === TokenType.Punctuator && (t.value === "{" || t.value === "}"));
    expect(braceTokens.length).toBeGreaterThanOrEqual(2);
  });

  it("format pass does not crash on code with escaped-bracket regex", () => {
    const code = String.raw`
      function test(str) {
        if (/\[{2}\d.*?\]{2}/.test(str)) {
          str = str.replace(/\[{2}\d.*?\]{2}/, function(s) {
            return '(' + s + ')';
          });
        }
        return str;
      }
    `;
    expect(() => runPipeline(code, [], [formatPass])).not.toThrow();
  });

  it("handles multiple escape sequences in regex", () => {
    const code = String.raw`/\[\]\(\)\{\}/`;
    const tokens = tokenize(code);
    const regexTokens = tokens.filter(t => t.type === TokenType.RegExp);
    expect(regexTokens).toHaveLength(1);
    expect(regexTokens[0].value).toBe(code);
  });
});

describe("H04: anti-debug preserving inner business logic", () => {
  it("preserves business logic inside self-defending wrapper", () => {
    // Reproduces debug-protection pattern — firstCall wrapper around real code
    const code = `
      (function() {
        var _0x1234 = (function() {
          var firstCall = true;
          return function(context, fn) {
            var rfn = firstCall ? function() {
              if (fn) { var res = fn.apply(context, arguments); fn = null; return res; }
            } : function() {};
            firstCall = false;
            return rfn;
          };
        }());
        var max = 0;
        var arr = [3, 1, 4, 1, 5];
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] > max) max = arr[i];
        }
        console.log(max);
      }());
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    // Business logic must survive — max, arr, console.log
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("console");
  });

  it("still removes standalone self-defending guards", () => {
    // Guard with no business logic — self-defending pattern detected in factory argument
    const code = `
      var _0xabcd = _0xfactory(this, function() {
        var test = new RegExp("(((.+)+)+)+$");
        return test.toString();
      });
      _0xabcd();
      console.log("real code");
    `;
    const result = runPipeline(code, [antiDebugPass], [formatPass]);
    // The self-defending guard + call should be removed, real code preserved
    expect(result).toContain("console");
    expect(result).not.toContain("_0xabcd");
  });
});
