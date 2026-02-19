import { describe, it, expect } from "vitest";
import { runTokenPipeline, runASTPipeline } from "../src/pipeline.js";
import type { ASTPass, TokenPass } from "../src/types.js";
import { parse, generate } from "../src/parser.js";
import { traverse, t } from "../src/babel.js";

describe("token pipeline", () => {
  it("returns input unchanged when no passes are given", () => {
    expect(runTokenPipeline("var x = 1;", [])).toBe("var x = 1;");
  });

  it("runs passes in sequence", () => {
    const upper: TokenPass = {
      name: "upper",
      description: "uppercase",
      run: (s) => s.toUpperCase(),
    };
    const exclaim: TokenPass = {
      name: "exclaim",
      description: "add exclamation",
      run: (s) => s + "!",
    };
    expect(runTokenPipeline("hello", [upper, exclaim])).toBe("HELLO!");
  });
});

describe("R15: iterative convergence", () => {
  it("converges when passes produce no further changes", () => {
    // Identity pass — always returns unchanged AST
    const identityPass: ASTPass = {
      name: "identity",
      description: "noop",
      run: (ast) => ast,
    };
    const result = runASTPipeline("var x = 1;", [identityPass], { maxIterations: 5 });
    expect(result).toContain("var x = 1");
  });

  it("runs multiple iterations when passes create new work for earlier passes", () => {
    // Simulate convergence: pass A enables work for pass B on next iteration
    // We use a counter to track how many times each pass runs
    let passARuns = 0;
    let passBRuns = 0;

    // Pass A: replaces 'MARKER_A' with 'DONE_A' (but only if present)
    const passA: ASTPass = {
      name: "pass-a",
      description: "replace marker a",
      run: (ast) => {
        passARuns++;
        // Simple: traverse looking for string literals
        // traverse and t imported at top of file
        traverse(ast, {
          StringLiteral(path: any) {
            if (path.node.value === "MARKER_A") {
              path.node.value = "DONE_A";
            }
          },
        });
        return ast;
      },
    };

    // Pass B: replaces 'TRIGGER' with 'MARKER_A' (creating work for pass A on next iteration)
    const passB: ASTPass = {
      name: "pass-b",
      description: "replace trigger",
      run: (ast) => {
        passBRuns++;
        // traverse and t imported at top of file
        traverse(ast, {
          StringLiteral(path: any) {
            if (path.node.value === "TRIGGER") {
              path.node.value = "MARKER_A";
            }
          },
        });
        return ast;
      },
    };

    const result = runASTPipeline(
      "var x = 'TRIGGER';",
      [passA, passB],
      { maxIterations: 5 },
    );
    // Iteration 1: passA finds nothing, passB replaces TRIGGER→MARKER_A
    // Iteration 2: passA replaces MARKER_A→DONE_A, passB finds nothing
    // Iteration 3: no changes → convergence
    expect(result).toContain("DONE_A");
    expect(passARuns).toBeGreaterThanOrEqual(2);
  });

  it("respects max iteration limit", () => {
    let runs = 0;
    const infinitePass: ASTPass = {
      name: "infinite",
      description: "always changes",
      run: (ast) => {
        runs++;
        // Always mutate to prevent convergence
        // traverse imported at top of file
        traverse(ast, {
          NumericLiteral(path: any) {
            path.node.value++;
          },
        });
        return ast;
      },
    };

    runASTPipeline("var x = 0;", [infinitePass], { maxIterations: 3 });
    expect(runs).toBe(3);
  });

  it("returns correct output after convergence", () => {
    const result = runASTPipeline("var x = 1;", [], { maxIterations: 10 });
    expect(result).toContain("var x = 1");
  });
});

describe("R18: safe/unsafe classification", () => {
  it("passes can declare safety level", () => {
    const safePass: ASTPass = {
      name: "safe",
      description: "safe pass",
      safety: "safe",
      run: (ast) => ast,
    };
    const unsafePass: ASTPass = {
      name: "unsafe",
      description: "unsafe pass",
      safety: "unsafe",
      run: (ast) => ast,
    };
    expect(safePass.safety).toBe("safe");
    expect(unsafePass.safety).toBe("unsafe");
  });

  it("passes without safety field default to safe", () => {
    const pass: ASTPass = {
      name: "test",
      description: "no safety field",
      run: (ast) => ast,
    };
    // undefined safety should be treated as safe
    expect(pass.safety).toBeUndefined();
  });

  it("filterSafePasses removes unsafe passes", async () => {
    const { filterSafePasses } = await import("../src/pipeline.js");
    const safe: ASTPass = { name: "s", description: "", safety: "safe", run: (ast) => ast };
    const unsafe: ASTPass = { name: "u", description: "", safety: "unsafe", run: (ast) => ast };
    const noLabel: ASTPass = { name: "n", description: "", run: (ast) => ast };

    const filtered = filterSafePasses([safe, unsafe, noLabel]);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(p => p.name)).toEqual(["s", "n"]);
  });
});
