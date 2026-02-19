import { describe, it, expect } from "vitest";
import { runTokenPipeline } from "../src/pipeline.js";
import type { TokenPass } from "../src/types.js";

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
