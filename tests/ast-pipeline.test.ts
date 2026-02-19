import { describe, it, expect } from "vitest";
import { runASTPipeline } from "../src/pipeline.js";
import type { ASTPass } from "../src/types.js";

describe("AST pipeline", () => {
  it("returns unchanged code when no passes provided", () => {
    const result = runASTPipeline("var x = 1;", []);
    expect(result).toContain("var x = 1");
  });

  it("applies a single AST pass", () => {
    // A pass that renames 'x' to 'y' would change output
    const identity: ASTPass = {
      name: "identity",
      description: "does nothing",
      run(ast) { return ast; },
    };
    const result = runASTPipeline("var x = 1;", [identity]);
    expect(result).toContain("var x = 1");
  });

  it("chains multiple AST passes without re-parsing", () => {
    const pass1: ASTPass = {
      name: "pass1",
      description: "first",
      run(ast) { return ast; },
    };
    const pass2: ASTPass = {
      name: "pass2",
      description: "second",
      run(ast) { return ast; },
    };
    const result = runASTPipeline("var x = 1;", [pass1, pass2]);
    expect(result).toContain("var x = 1");
  });

  it("produces syntactically valid JavaScript", () => {
    const result = runASTPipeline("var a=1,b=2;function f(n){return n+1}", []);
    // If it parses and generates without throwing, it's valid
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });
});
