/**
 * RESEARCH-01 Phase 3: Advanced Algorithms
 * A1: Tarjan's SCC for pass scheduling
 * A3: Arithmetic control flow dispatcher recovery
 */
import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";

// === A1: Tarjan's SCC for pass ordering ===

describe("A1: pass dependency graph + Tarjan's SCC", () => {
  it("finds SCCs in a pass dependency graph", async () => {
    const { findSCCs } = await import("../src/pass-scheduler.js");
    // A → B → C → A (cycle), D → A (no cycle with D)
    const graph = new Map<string, string[]>();
    graph.set("A", ["B"]);
    graph.set("B", ["C"]);
    graph.set("C", ["A"]);
    graph.set("D", ["A"]);

    const sccs = findSCCs(graph);
    // Should find one SCC containing {A, B, C} and one singleton {D}
    const cycleSCC = sccs.find(scc => scc.length > 1);
    expect(cycleSCC).toBeDefined();
    expect(cycleSCC!.sort()).toEqual(["A", "B", "C"]);
  });

  it("returns singletons for acyclic graphs", async () => {
    const { findSCCs } = await import("../src/pass-scheduler.js");
    const graph = new Map<string, string[]>();
    graph.set("A", ["B"]);
    graph.set("B", ["C"]);
    graph.set("C", []);

    const sccs = findSCCs(graph);
    expect(sccs.length).toBe(3);
    expect(sccs.every(scc => scc.length === 1)).toBe(true);
  });

  it("topological sort produces valid execution order", async () => {
    const { topologicalSort } = await import("../src/pass-scheduler.js");
    // D depends on nothing, A→B→C is a cycle, D→A
    const graph = new Map<string, string[]>();
    graph.set("D", ["A"]);
    graph.set("A", ["B"]);
    graph.set("B", ["C"]);
    graph.set("C", ["A"]);

    const order = topologicalSort(graph);
    // D must come before A (since D→A)
    const dIdx = order.indexOf("D");
    const aIdx = order.indexOf("A");
    expect(dIdx).toBeLessThan(aIdx);
  });

  it("identifies the deobfuscator pass dependency graph correctly", async () => {
    const { PASS_DEPENDENCIES, findSCCs } = await import("../src/pass-scheduler.js");
    // The constant-propagate ↔ dead-code-eliminate pair should form an SCC
    const sccs = findSCCs(PASS_DEPENDENCIES);
    const hasPropDeadCycle = sccs.some(scc =>
      scc.includes("constant-propagate") && scc.includes("dead-code-eliminate")
    );
    expect(hasPropDeadCycle).toBe(true);

    // Rename passes should be singletons (terminal)
    const renameSCC = sccs.find(scc => scc.includes("semantic-rename"));
    expect(renameSCC).toBeDefined();
    expect(renameSCC!.length).toBe(1);
  });
});

// === A3: Arithmetic control flow dispatcher recovery ===

describe("A3: arithmetic control flow dispatcher", () => {
  it("recovers execution order from arithmetic state machine", async () => {
    const { controlFlowUnflattenPass } = await import("../src/passes/control-flow-unflatten.js");
    // Arithmetic dispatcher: state = state * 2 + 1 style
    // State sequence: 0 → case 0: stmt_a, state=2 → case 2: stmt_b, state=5 → case 5: stmt_c
    const code = `
      var _0xstate = 0;
      while (true) {
        switch (_0xstate) {
          case 0:
            console.log("a");
            _0xstate = 2;
            continue;
          case 2:
            console.log("b");
            _0xstate = 5;
            continue;
          case 5:
            console.log("c");
            _0xstate = -1;
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
    // Should reconstruct linear flow: a, b, c in order
    const aIdx = output.indexOf('"a"');
    const bIdx = output.indexOf('"b"');
    const cIdx = output.indexOf('"c"');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it("handles simple sequential state assignments", async () => {
    const { controlFlowUnflattenPass } = await import("../src/passes/control-flow-unflatten.js");
    const code = `
      var _0xs = 1;
      while (!![]) {
        switch (_0xs) {
          case 1:
            var x = 10;
            _0xs = 3;
            continue;
          case 3:
            var y = 20;
            _0xs = 7;
            continue;
          case 7:
            var z = x + y;
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
    // Should have x=10, y=20, z=x+y in order, without the switch
    expect(output).not.toContain("switch");
    expect(output).toContain("x = 10");
    expect(output).toContain("y = 20");
  });

  it("falls back gracefully when state transitions are non-deterministic", async () => {
    const { controlFlowUnflattenPass } = await import("../src/passes/control-flow-unflatten.js");
    // Non-deterministic: state depends on runtime value
    const code = `
      var _0xs = 0;
      while (true) {
        switch (_0xs) {
          case 0:
            _0xs = Math.random() > 0.5 ? 1 : 2;
            continue;
          case 1:
            console.log("path1");
            break;
          case 2:
            console.log("path2");
            break;
        }
        break;
      }
    `;
    const ast = parse(code);
    const before = generate(ast);
    const result = controlFlowUnflattenPass.run(ast, code);
    const after = generate(result);
    // Should leave code unchanged (non-deterministic state = can't resolve)
    expect(after).toContain("switch");
  });
});
