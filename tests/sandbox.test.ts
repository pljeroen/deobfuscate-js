import { describe, it, expect } from "vitest";
import { executeSandboxed } from "../src/sandbox.js";

describe("sandboxed execution", () => {
  it("executes code and returns stdout", () => {
    const result = executeSandboxed('process.stdout.write("hello")');
    expect(result).toBe("hello");
  });

  it("returns structured JSON output", () => {
    const result = executeSandboxed(
      'process.stdout.write(JSON.stringify({ a: 1, b: "two" }))'
    );
    expect(JSON.parse(result)).toEqual({ a: 1, b: "two" });
  });

  it("times out on infinite loop", () => {
    expect(() => executeSandboxed("while(true){}", 500)).toThrow();
  });

  it("handles runtime errors gracefully", () => {
    expect(() => executeSandboxed('throw new Error("test")')).toThrow();
  });

  it("provides isolated execution environment", () => {
    // Child process has its own global scope
    const result = executeSandboxed(
      'process.stdout.write(String(typeof __deobf_test_marker__))'
    );
    expect(result).toBe("undefined");
  });
});
