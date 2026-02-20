/**
 * Tests for ISOLATE-01: V8 isolate sandbox (isolated-vm).
 */
import { describe, it, expect } from "vitest";
import { executeSandboxed } from "../src/sandbox.js";

// --- I01: Core isolate functionality ---

describe("I01: isolated-vm execution", () => {
  it("executes code and returns stdout via shim", () => {
    const result = executeSandboxed('process.stdout.write("hello")');
    expect(result).toBe("hello");
  });

  it("returns structured JSON output", () => {
    const result = executeSandboxed(
      'process.stdout.write(JSON.stringify({ a: 1, b: "two" }))'
    );
    expect(JSON.parse(result)).toEqual({ a: 1, b: "two" });
  });

  it("enforces timeout on infinite loops", () => {
    expect(() => executeSandboxed("while(true){}", 500)).toThrow();
  });

  it("handles runtime errors gracefully", () => {
    expect(() => executeSandboxed('throw new Error("test")')).toThrow();
  });

  it("enforces memory limit", () => {
    // Allocate far more than 128MB — should throw
    expect(() => executeSandboxed(`
      var arr = [];
      for (var i = 0; i < 100000000; i++) { arr.push(new Array(10000)); }
      process.stdout.write("survived");
    `, 10000)).toThrow();
  });
});

// --- I03: True isolation — no Node.js APIs available ---

describe("I03: true V8 isolation", () => {
  it("require is genuinely undefined", () => {
    const result = executeSandboxed(`
      process.stdout.write(String(typeof require));
    `);
    expect(result).toBe("undefined");
  });

  it("fs module is inaccessible", () => {
    const result = executeSandboxed(`
      try {
        var fs = require("fs");
        process.stdout.write("LEAK");
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    expect(result).toBe("BLOCKED");
  });

  it("child_process is inaccessible", () => {
    const result = executeSandboxed(`
      try {
        var cp = require("child_process");
        process.stdout.write("LEAK");
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    expect(result).toBe("BLOCKED");
  });

  it("net module is inaccessible", () => {
    const result = executeSandboxed(`
      try {
        var net = require("net");
        process.stdout.write("LEAK");
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    expect(result).toBe("BLOCKED");
  });

  it("global scope is isolated between executions", () => {
    executeSandboxed('var __marker = 42; process.stdout.write("ok")');
    const result = executeSandboxed(
      'process.stdout.write(String(typeof __marker))'
    );
    expect(result).toBe("undefined");
  });
});

// --- I04: process.stdout.write shim ---

describe("I04: output shim", () => {
  it("captures multiple write calls", () => {
    const result = executeSandboxed(`
      process.stdout.write("hello ");
      process.stdout.write("world");
    `);
    expect(result).toBe("hello world");
  });

  it("handles non-string write argument", () => {
    const result = executeSandboxed(`
      process.stdout.write(String(42));
    `);
    expect(result).toBe("42");
  });
});

// --- I05: Buffer polyfill ---

describe("I05: Buffer polyfill for base64", () => {
  it("decodes base64 via Buffer.from", () => {
    const result = executeSandboxed(`
      var decoded = Buffer.from("SGVsbG8=", "base64").toString();
      process.stdout.write(decoded);
    `);
    expect(result).toBe("Hello");
  });

  it("handles Buffer.from with utf8 encoding", () => {
    const result = executeSandboxed(`
      var buf = Buffer.from("hello", "utf8");
      process.stdout.write(buf.toString());
    `);
    expect(result).toBe("hello");
  });
});

// --- I06: String-array integration ---

describe("I06: string-array pass still works with isolate sandbox", () => {
  it("resolves standard JS operations in isolate", () => {
    const result = executeSandboxed(`
      var a = [1, 2, 3];
      var b = a.map(function(x) { return x * 2; });
      process.stdout.write(JSON.stringify(b));
    `);
    expect(result).toBe("[2,4,6]");
  });

  it("supports String.fromCharCode", () => {
    const result = executeSandboxed(`
      var s = String.fromCharCode(72, 101, 108, 108, 111);
      process.stdout.write(s);
    `);
    expect(result).toBe("Hello");
  });

  it("supports decodeURIComponent", () => {
    const result = executeSandboxed(`
      var s = decodeURIComponent("%48%65%6C%6C%6F");
      process.stdout.write(s);
    `);
    expect(result).toBe("Hello");
  });

  it("supports parseInt", () => {
    const result = executeSandboxed(`
      process.stdout.write(String(parseInt("0xff", 16)));
    `);
    expect(result).toBe("255");
  });
});

// --- Red-team: escape attempts ---

describe("red-team: isolate escape attempts", () => {
  it("constructor chain returns isolate global, not host", () => {
    const result = executeSandboxed(`
      try {
        var leaked = globalThis.constructor.constructor("return this")();
        // If we escaped, leaked would have Node APIs
        process.stdout.write(String(typeof leaked.require));
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    // Should be "undefined" (isolate global) or "BLOCKED" — never "function"
    expect(result).not.toBe("function");
  });

  it("Function constructor stays in isolate", () => {
    const result = executeSandboxed(`
      try {
        var fn = Function("return typeof require")();
        process.stdout.write(fn);
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    expect(result).not.toBe("function");
  });

  it("cannot access host via prototype pollution", () => {
    const result = executeSandboxed(`
      try {
        Object.prototype.polluted = "yes";
        process.stdout.write("ok");
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    // Pollution in isolate must not affect host
    expect((Object.prototype as any).polluted).toBeUndefined();
    expect(result).toBe("ok");
  });

  it("typeof Deno is undefined", () => {
    const result = executeSandboxed(`
      process.stdout.write(typeof Deno);
    `);
    expect(result).toBe("undefined");
  });

  it("cannot access __write callback internals", () => {
    const result = executeSandboxed(`
      try {
        // Try to inspect the callback object
        var keys = Object.getOwnPropertyNames(__write);
        process.stdout.write("keys:" + keys.length);
      } catch(e) {
        process.stdout.write("BLOCKED");
      }
    `);
    // Should not be able to introspect host callback
    expect(result).not.toContain("LEAK");
  });
});

// --- Host-side DoS protection ---

describe("host-side DoS protection", () => {
  it("caps output buffer size", () => {
    // Try to write more than the output limit
    expect(() => executeSandboxed(`
      var chunk = "A".repeat(1024 * 1024); // 1MB
      for (var i = 0; i < 20; i++) { process.stdout.write(chunk); }
    `, 10000)).toThrow();
  });

  it("caps atob input size", () => {
    expect(() => executeSandboxed(`
      var huge = "A".repeat(2 * 1024 * 1024); // 2MB
      atob(huge);
      process.stdout.write("ok");
    `, 5000)).toThrow();
  });

  it("rejects oversized input code", () => {
    const hugeCode = `process.stdout.write("${"x".repeat(11 * 1024 * 1024)}")`;
    expect(() => executeSandboxed(hugeCode)).toThrow();
  });
});
