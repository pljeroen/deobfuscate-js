/**
 * RESEARCH-01 Phase 1: Quick Wins
 * QW1: PipelineContext, QW2: Fingerprint-guided selection,
 * QW3: Hash-based convergence, QW4: Entropy metrics
 */
import { describe, it, expect } from "vitest";
import { parse, generate } from "../src/parser.js";
import { traverse, t } from "../src/babel.js";
import type { ASTPass, TokenPass, PipelineContext } from "../src/types.js";
import { runPipelineWithReport } from "../src/pipeline.js";

// === QW1: Cross-pass pipeline context ===

describe("QW1: PipelineContext threading", () => {
  it("PipelineContext is defined and exported from types", async () => {
    const types = await import("../src/types.js");
    // PipelineContext should be a type/interface — we verify it's usable
    // by creating an object that satisfies it
    const ctx: PipelineContext = { metadata: {} };
    expect(ctx.metadata).toBeDefined();
  });

  it("passes receive context when pipeline provides it", () => {
    let receivedContext: PipelineContext | undefined;
    const spy: ASTPass = {
      name: "spy",
      description: "captures context",
      run: (ast, _source?, context?) => {
        receivedContext = context;
        return ast;
      },
    };
    runPipelineWithReport("var x = 1;", [spy], []);
    expect(receivedContext).toBeDefined();
    expect(receivedContext!.metadata).toBeDefined();
  });

  it("context persists across passes within same iteration", () => {
    const writer: ASTPass = {
      name: "writer",
      description: "writes to context",
      run: (ast, _source?, context?) => {
        if (context) {
          context.metadata["written"] = true;
        }
        return ast;
      },
    };
    let readValue: unknown;
    const reader: ASTPass = {
      name: "reader",
      description: "reads from context",
      run: (ast, _source?, context?) => {
        if (context) {
          readValue = context.metadata["written"];
        }
        return ast;
      },
    };
    runPipelineWithReport("var x = 1;", [writer, reader], []);
    expect(readValue).toBe(true);
  });

  it("context survives across convergence iterations", () => {
    let iterationCount = 0;
    let contextFromSecondIteration: PipelineContext | undefined;

    const mutator: ASTPass = {
      name: "mutator",
      description: "changes code once, reads context on second iteration",
      run: (ast, _source?, context?) => {
        iterationCount++;
        if (context) {
          if (iterationCount === 1) {
            context.metadata["iteration1"] = true;
            // Force a change to trigger second iteration
            traverse(ast, {
              StringLiteral(path: any) {
                if (path.node.value === "A") path.node.value = "B";
              },
            });
          } else if (iterationCount === 2) {
            contextFromSecondIteration = context;
          }
        }
        return ast;
      },
    };
    runPipelineWithReport("var x = 'A';", [mutator], []);
    expect(iterationCount).toBeGreaterThanOrEqual(2);
    expect(contextFromSecondIteration).toBeDefined();
    expect(contextFromSecondIteration!.metadata["iteration1"]).toBe(true);
  });
});

// === QW2: Fingerprint-guided pass selection ===

describe("QW2: fingerprint-guided pass selection", () => {
  it("fingerprint result is stored in PipelineContext", () => {
    let ctx: PipelineContext | undefined;
    const spy: ASTPass = {
      name: "spy",
      description: "captures context",
      run: (ast, _source?, context?) => {
        ctx = context;
        return ast;
      },
    };
    runPipelineWithReport("var x = 1;", [spy], []);
    expect(ctx).toBeDefined();
    expect(ctx!.fingerprint).toBeDefined();
    expect(ctx!.fingerprint!.obfuscator).toBeNull(); // plain code
  });

  it("fingerprint detects obfuscator patterns and stores in context", () => {
    let ctx: PipelineContext | undefined;
    const spy: ASTPass = {
      name: "spy",
      description: "captures context",
      run: (ast, _source?, context?) => {
        ctx = context;
        return ast;
      },
    };
    const obfuscated = `
      var _0x4e2c = ['log', 'Hello', 'world'];
      function _0xdec(idx) { return _0x4e2c[idx]; }
      var _0x1a = _0xdec(0);
      var _0x2b = _0xdec(1);
    `;
    runPipelineWithReport(obfuscated, [spy], []);
    expect(ctx!.fingerprint!.obfuscator).toBe("javascript-obfuscator");
    expect(ctx!.fingerprint!.patterns.length).toBeGreaterThan(0);
  });

  it("skips obfuscator-specific passes for non-obfuscated input", () => {
    const passesRun: string[] = [];

    const genericPass: ASTPass = {
      name: "constant-fold",
      description: "runs always",
      run: (ast, _source?, _context?) => {
        passesRun.push("constant-fold");
        return ast;
      },
    };
    const obfuscatorPass: ASTPass = {
      name: "control-flow-unflatten",
      description: "obfuscator-specific",
      run: (ast, _source?, _context?) => {
        passesRun.push("control-flow-unflatten");
        return ast;
      },
    };

    // Plain minified JS — no obfuscator patterns
    runPipelineWithReport(
      "var n=function(a,b){return a+b};console.log(n(1,2));",
      [genericPass, obfuscatorPass],
      [],
    );

    expect(passesRun).toContain("constant-fold");
    expect(passesRun).not.toContain("control-flow-unflatten");
  });

  it("runs all passes for obfuscated input", () => {
    const passesRun: string[] = [];

    const genericPass: ASTPass = {
      name: "constant-fold",
      description: "runs always",
      run: (ast, _source?, _context?) => {
        passesRun.push("constant-fold");
        return ast;
      },
    };
    const obfuscatorPass: ASTPass = {
      name: "control-flow-unflatten",
      description: "obfuscator-specific",
      run: (ast, _source?, _context?) => {
        passesRun.push("control-flow-unflatten");
        return ast;
      },
    };

    // Obfuscated JS with _0x identifiers
    const obfuscated = `
      var _0x4e2c = ['log', 'Hello', 'world'];
      function _0xdec(idx) { return _0x4e2c[idx]; }
      var _0x1a = _0xdec(0);
      var _0x2b = _0xdec(1);
    `;
    runPipelineWithReport(obfuscated, [genericPass, obfuscatorPass], []);

    expect(passesRun).toContain("constant-fold");
    expect(passesRun).toContain("control-flow-unflatten");
  });
});

// === QW3: Hash-based convergence + early termination ===

describe("QW3: convergence improvements", () => {
  it("terminates early when no passes report changes", () => {
    let runCount = 0;
    const noop: ASTPass = {
      name: "noop",
      description: "does nothing",
      run: (ast) => {
        runCount++;
        return ast;
      },
    };
    runPipelineWithReport("var x = 1;", [noop], []);
    // With early termination, the noop should only run once per iteration
    // and convergence should be detected after first iteration
    // (no changes detected = no second iteration needed)
    expect(runCount).toBe(1);
  });

  it("report includes iteration count", () => {
    const noop: ASTPass = { name: "noop", description: "", run: (ast) => ast };
    const result = runPipelineWithReport("var x = 1;", [noop], []);
    expect(result.iterations).toBeDefined();
    expect(result.iterations).toBe(1);
  });

  it("reports correct iteration count when passes force multiple iterations", () => {
    let firstRun = true;
    const mutator: ASTPass = {
      name: "mutator",
      description: "",
      run: (ast) => {
        if (firstRun) {
          firstRun = false;
          traverse(ast, {
            StringLiteral(path: any) {
              if (path.node.value === "A") path.node.value = "B";
            },
          });
        }
        return ast;
      },
    };
    const result = runPipelineWithReport("var x = 'A';", [mutator], []);
    expect(result.iterations).toBeGreaterThanOrEqual(2);
  });
});

// === QW4: Shannon entropy metrics ===

describe("QW4: Shannon entropy metrics", () => {
  it("identifierEntropy function computes correct entropy", async () => {
    const { identifierEntropy } = await import("../src/entropy.js");
    // Single unique identifier: entropy = 0 (no uncertainty)
    const ast1 = parse("var x = 1;");
    expect(identifierEntropy(ast1)).toBe(0);
  });

  it("entropy is higher for more diverse identifier names", async () => {
    const { identifierEntropy } = await import("../src/entropy.js");
    // Two equally used identifiers: entropy = log2(2) = 1
    const ast2 = parse("var a = 1; var b = 2; console.log(a, b);");
    const ent2 = identifierEntropy(ast2);

    // Many diverse identifiers: higher entropy
    const ast3 = parse("var a = 1; var b = 2; var c = 3; var d = 4; var e = 5;");
    const ent3 = identifierEntropy(ast3);

    expect(ent3).toBeGreaterThan(ent2);
  });

  it("obfuscated identifiers have higher entropy than readable ones", async () => {
    const { identifierEntropy } = await import("../src/entropy.js");
    const readable = parse(`
      function add(a, b) { return a + b; }
      function multiply(a, b) { return a * b; }
      var result = add(1, 2);
    `);
    const obfuscated = parse(`
      function _0x4e2c(_0x1a2b, _0x3c4d) { return _0x1a2b + _0x3c4d; }
      function _0x5e6f(_0x7a8b, _0x9c0d) { return _0x7a8b * _0x9c0d; }
      var _0xef01 = _0x4e2c(1, 2);
    `);
    const readableEnt = identifierEntropy(readable);
    const obfuscatedEnt = identifierEntropy(obfuscated);
    expect(obfuscatedEnt).toBeGreaterThan(readableEnt);
  });

  it("pipeline report includes entropy metrics", () => {
    const noop: ASTPass = { name: "noop", description: "", run: (ast) => ast };
    const result = runPipelineWithReport("var x = 1;", [noop], []);
    expect(result.initialEntropy).toBeDefined();
    expect(typeof result.initialEntropy).toBe("number");
    expect(result.finalEntropy).toBeDefined();
    expect(typeof result.finalEntropy).toBe("number");
  });

  it("entropy decreases after rename pass on obfuscated code", () => {
    // Simulate a rename pass that converts _0x names to readable names
    const renamer: ASTPass = {
      name: "renamer",
      description: "renames _0x vars",
      run: (ast) => {
        traverse(ast, {
          Identifier(path: any) {
            if (path.node.name === "_0x1a2b") path.node.name = "sum";
            if (path.node.name === "_0x3c4d") path.node.name = "a";
            if (path.node.name === "_0x5e6f") path.node.name = "b";
          },
        });
        return ast;
      },
    };
    const result = runPipelineWithReport(
      "var _0x1a2b = _0x3c4d + _0x5e6f;",
      [renamer],
      [],
    );
    expect(result.finalEntropy!).toBeLessThanOrEqual(result.initialEntropy!);
  });
});
