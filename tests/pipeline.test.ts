import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline.js";
import { DeobfuscationPass } from "../src/types.js";

describe("pipeline", () => {
  it("returns input unchanged when no passes are given", () => {
    expect(runPipeline("var x = 1;", [])).toBe("var x = 1;");
  });

  it("runs passes in sequence", () => {
    const upper: DeobfuscationPass = {
      name: "upper",
      description: "uppercase",
      run: (s) => s.toUpperCase(),
    };
    const exclaim: DeobfuscationPass = {
      name: "exclaim",
      description: "add exclamation",
      run: (s) => s + "!",
    };
    expect(runPipeline("hello", [upper, exclaim])).toBe("HELLO!");
  });
});
