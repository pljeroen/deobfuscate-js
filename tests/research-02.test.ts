/**
 * RESEARCH-02: Remaining cross-disciplinary improvements
 * R01: Module centrality naming
 * R02: Cross-branch typeof folding
 * R03: Affine state transition solver
 */
import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";

// === R01: Module centrality naming ===

describe("R01: module centrality naming", () => {
  it("names the entry module based on bundle entry metadata", async () => {
    const { bundlerUnpackPass } = await import("../src/passes/bundler-unpack.js");
    // Webpack 4 with entry point at index 0
    // Module 0 requires module 1 and 2; module 1 requires nothing; module 2 requires module 1
    const code = `
      (function(modules) {
        function __webpack_require__(id) { return modules[id]; }
        __webpack_require__(0);
      })([
        function(module, exports, __webpack_require__) {
          var a = __webpack_require__(1);
          var b = __webpack_require__(2);
          console.log(a, b);
        },
        function(module, exports) {
          module.exports = "util";
        },
        function(module, exports, __webpack_require__) {
          var a = __webpack_require__(1);
          module.exports = a + "!";
        }
      ]);
    `;
    const ast = parse(code);
    const result = bundlerUnpackPass.run(ast, code);
    const output = generate(result);
    // Module 0 is entry (called by bootstrap), should be __module_entry__
    // Module 1 is required by both 0 and 2 (highest in-degree), should be __module_util_...
    // Module 2 is required by only 0, mixed role
    expect(output).toContain("__module_entry__");
  });

  it("identifies utility modules with high in-degree", async () => {
    const { bundlerUnpackPass } = await import("../src/passes/bundler-unpack.js");
    const code = `
      (function(modules) {
        function __webpack_require__(id) { return modules[id]; }
        __webpack_require__(0);
      })([
        function(module, exports, __webpack_require__) {
          var u = __webpack_require__(2);
          console.log(u);
        },
        function(module, exports, __webpack_require__) {
          var u = __webpack_require__(2);
          console.log(u);
        },
        function(module, exports) {
          module.exports = { helper: true };
        }
      ]);
    `;
    const ast = parse(code);
    const result = bundlerUnpackPass.run(ast, code);
    const output = generate(result);
    // Module 2 is required by modules 0 and 1 (in-degree 2), has no requires (leaf)
    // But it's the most-depended-on, so it should get a utility or leaf name
    expect(output).toMatch(/__module_(util|leaf)_2__/);
  });

  it("names leaf modules with zero out-degree", async () => {
    const { bundlerUnpackPass } = await import("../src/passes/bundler-unpack.js");
    const code = `
      (function(modules) {
        function __webpack_require__(id) { return modules[id]; }
        __webpack_require__(0);
      })([
        function(module, exports, __webpack_require__) {
          var a = __webpack_require__(1);
          var b = __webpack_require__(2);
        },
        function(module, exports) {
          module.exports = "leaf1";
        },
        function(module, exports) {
          module.exports = "leaf2";
        }
      ]);
    `;
    const ast = parse(code);
    const result = bundlerUnpackPass.run(ast, code);
    const output = generate(result);
    // Modules 1 and 2 have no __webpack_require__ calls — they're leaves
    expect(output).toMatch(/__module_leaf_1__/);
    expect(output).toMatch(/__module_leaf_2__/);
  });

  it("falls back to numeric naming when no clear structure", async () => {
    const { bundlerUnpackPass } = await import("../src/passes/bundler-unpack.js");
    // Single module — no graph structure
    const code = `
      (function(modules) {
        function __webpack_require__(id) { return modules[id]; }
        __webpack_require__(0);
      })([
        function(module, exports) {
          console.log("solo");
        }
      ]);
    `;
    const ast = parse(code);
    const result = bundlerUnpackPass.run(ast, code);
    const output = generate(result);
    // Only one module — no meaningful graph, use numeric
    expect(output).toMatch(/__module_(entry_)?0__/);
  });
});

// === R02: Cross-branch typeof folding ===

describe("R02: cross-branch typeof folding", () => {
  it("folds typeof when both if/else branches assign same type", async () => {
    const { constantPropagatePass } = await import("../src/passes/constant-propagate.js");
    const code = `
      var x;
      if (condition) {
        x = "hello";
      } else {
        x = "world";
      }
      var t = typeof x;
    `;
    const ast = parse(code);
    const result = constantPropagatePass.run(ast, code);
    const output = generate(result);
    expect(output).toContain('"string"');
  });

  it("does NOT fold typeof when branches assign different types", async () => {
    const { constantPropagatePass } = await import("../src/passes/constant-propagate.js");
    const code = `
      var x;
      if (condition) {
        x = "hello";
      } else {
        x = 42;
      }
      var t = typeof x;
    `;
    const ast = parse(code);
    const result = constantPropagatePass.run(ast, code);
    const output = generate(result);
    // typeof should remain since branches have different types
    expect(output).toContain("typeof x");
  });

  it("folds typeof for number type across branches", async () => {
    const { constantPropagatePass } = await import("../src/passes/constant-propagate.js");
    const code = `
      var x;
      if (condition) {
        x = 1;
      } else {
        x = 2;
      }
      var t = typeof x;
    `;
    const ast = parse(code);
    const result = constantPropagatePass.run(ast, code);
    const output = generate(result);
    expect(output).toContain('"number"');
  });

  it("folds typeof for boolean type across branches", async () => {
    const { constantPropagatePass } = await import("../src/passes/constant-propagate.js");
    const code = `
      var x;
      if (condition) {
        x = true;
      } else {
        x = false;
      }
      var t = typeof x;
    `;
    const ast = parse(code);
    const result = constantPropagatePass.run(ast, code);
    const output = generate(result);
    expect(output).toContain('"boolean"');
  });

  it("does NOT fold when variable has more than 2 assignments", async () => {
    const { constantPropagatePass } = await import("../src/passes/constant-propagate.js");
    const code = `
      var x = "initial";
      if (a) { x = "one"; }
      if (b) { x = "two"; }
      var t = typeof x;
    `;
    const ast = parse(code);
    const result = constantPropagatePass.run(ast, code);
    const output = generate(result);
    // 3 possible assignments — can't guarantee type
    expect(output).toContain("typeof x");
  });

  it("preserves existing single-assignment constant propagation", async () => {
    const { constantPropagatePass } = await import("../src/passes/constant-propagate.js");
    const code = `var x = 42; var y = x + 1;`;
    const ast = parse(code);
    const result = constantPropagatePass.run(ast, code);
    const output = generate(result);
    // x should be inlined as 42
    expect(output).toContain("42 + 1");
  });
});

// === R03: Affine state transition solver ===

describe("R03: affine state transition solver", () => {
  it("recovers order from additive state transitions (state = state + C)", async () => {
    const { controlFlowUnflattenPass } = await import("../src/passes/control-flow-unflatten.js");
    // State sequence: 0 → +3 → 3 → +3 → 6 → terminal
    const code = `
      var _0xs = 0;
      while (true) {
        switch (_0xs) {
          case 0:
            console.log("first");
            _0xs = _0xs + 3;
            continue;
          case 3:
            console.log("second");
            _0xs = _0xs + 3;
            continue;
          case 6:
            console.log("third");
            _0xs = -1;
            continue;
          case -1:
            break;
        }
        break;
      }
    `;
    const ast = parse(code);
    const result = controlFlowUnflattenPass.run(ast, code);
    const output = generate(result);
    const first = output.indexOf('"first"');
    const second = output.indexOf('"second"');
    const third = output.indexOf('"third"');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(output).not.toContain("switch");
  });

  it("recovers order from multiplicative state transitions (state = state * K + C)", async () => {
    const { controlFlowUnflattenPass } = await import("../src/passes/control-flow-unflatten.js");
    // State: 1 → *2+1=3 → *2+1=7 → terminal
    const code = `
      var _0xs = 1;
      while (!![]) {
        switch (_0xs) {
          case 1:
            console.log("a");
            _0xs = _0xs * 2 + 1;
            continue;
          case 3:
            console.log("b");
            _0xs = _0xs * 2 + 1;
            continue;
          case 7:
            console.log("c");
            _0xs = 0;
            continue;
          case 0:
            break;
        }
        break;
      }
    `;
    const ast = parse(code);
    const result = controlFlowUnflattenPass.run(ast, code);
    const output = generate(result);
    const a = output.indexOf('"a"');
    const b = output.indexOf('"b"');
    const c = output.indexOf('"c"');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(output).not.toContain("switch");
  });

  it("recovers order from XOR state transitions (state = state ^ C)", async () => {
    const { controlFlowUnflattenPass } = await import("../src/passes/control-flow-unflatten.js");
    // State: 5 → ^3=6 → ^3=5 would be a cycle, so use different XOR constants
    // State: 10 → ^7=13 → ^2=15 → terminal
    const code = `
      var _0xs = 10;
      while (true) {
        switch (_0xs) {
          case 10:
            console.log("x");
            _0xs = _0xs ^ 7;
            continue;
          case 13:
            console.log("y");
            _0xs = _0xs ^ 2;
            continue;
          case 15:
            console.log("z");
            _0xs = -1;
            continue;
          case -1:
            break;
        }
        break;
      }
    `;
    const ast = parse(code);
    const result = controlFlowUnflattenPass.run(ast, code);
    const output = generate(result);
    const x = output.indexOf('"x"');
    const y = output.indexOf('"y"');
    const z = output.indexOf('"z"');
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThan(x);
    expect(z).toBeGreaterThan(y);
  });

  it("terminates on cycle detection (no infinite loop)", async () => {
    const { controlFlowUnflattenPass } = await import("../src/passes/control-flow-unflatten.js");
    // State: 1 → ^1=0 → ^1=1 → cycle! Should bail out.
    const code = `
      var _0xs = 1;
      while (true) {
        switch (_0xs) {
          case 1:
            console.log("a");
            _0xs = _0xs ^ 1;
            continue;
          case 0:
            console.log("b");
            _0xs = _0xs ^ 1;
            continue;
        }
        break;
      }
    `;
    const ast = parse(code);
    const before = generate(ast);
    // This should NOT hang — cycle detection kicks in
    const result = controlFlowUnflattenPass.run(ast, code);
    const output = generate(result);
    // With cycle, the pass should still produce some output
    // (either leave code unchanged or partially unroll)
    expect(output).toBeDefined();
  }, 10000);

  it("preserves existing pipe-delimited pattern support", async () => {
    const { controlFlowUnflattenPass } = await import("../src/passes/control-flow-unflatten.js");
    const code = `
      var _0x = '1|0|2'.split('|');
      var _0xi = 0;
      while (!![]) {
        switch (_0x[_0xi++]) {
          case '0': console.log("b"); continue;
          case '1': console.log("a"); continue;
          case '2': console.log("c"); continue;
        }
        break;
      }
    `;
    const ast = parse(code);
    const result = controlFlowUnflattenPass.run(ast, code);
    const output = generate(result);
    const a = output.indexOf('"a"');
    const b = output.indexOf('"b"');
    const c = output.indexOf('"c"');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
