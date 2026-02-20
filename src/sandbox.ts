/**
 * V8 isolate sandbox using isolated-vm.
 *
 * Runs untrusted JavaScript in a separate V8 isolate with no Node globals
 * exposed. Access to Node APIs only exists if explicitly bridged by the host.
 *
 * Security properties:
 * - Separate V8 heap with 128MB memory limit (engine-enforced)
 * - Wall-clock timeout via V8 TerminateExecution (engine-enforced)
 * - No require, fs, net, child_process, or any Node.js API
 * - No file system I/O — execution is entirely in-memory
 * - Deterministic: Date.now() frozen, Math.random() seeded
 *
 * Host bridge (3 callbacks, all string-in/string-out, all size-capped):
 * - __write(str)  — appends to output buffer (10MB cap)
 * - __atob(str)   — base64 decode (1MB input cap)
 * - __btoa(str)   — base64 encode (1MB input cap)
 *
 * Provides minimal shims built on the bridge:
 * - process.stdout.write() — captures output via __write
 * - Buffer.from(str, 'base64') — base64 via __atob
 * - atob/btoa — Web API base64 via __atob/__btoa
 * - Date.now() / new Date() — frozen to constant (deterministic)
 * - Math.random() — seeded xorshift32 PRNG (deterministic)
 * - console.log/warn/error/info — no-ops (prevents ReferenceError)
 *
 * Supply chain note: isolated-vm is a native C++ addon. The security
 * boundary shifts from "executing attacker JS" to "native addon correctness".
 * Version is pinned to exact release to prevent unaudited updates.
 */

import ivm from "isolated-vm";

/** Maximum sandbox timeout to prevent DoS (15 seconds) */
const MAX_TIMEOUT = 15000;

/** Memory limit for the V8 isolate in megabytes */
const MEMORY_LIMIT_MB = 128;

/** Maximum output buffer size (10MB) — prevents host DoS via stdout spam */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Maximum input size for atob/btoa callbacks (1MB) */
const MAX_BASE64_INPUT = 1024 * 1024;

/** Maximum input code size (10MB) */
const MAX_CODE_SIZE = 10 * 1024 * 1024;

/**
 * Preamble injected into the isolate to provide minimal API shims.
 * These are thin wrappers around callbacks injected from the host.
 */
const ISOLATE_PREAMBLE = `
var process = {
  stdout: { write: function(s) { __write(String(s)); } },
  env: {}
};
var console = {
  log: function() {},
  warn: function() {},
  error: function() {},
  info: function() {}
};
var atob = __atob;
var btoa = __btoa;
var Buffer = {
  from: function(str, encoding) {
    var decoded = str;
    if (encoding === 'base64') {
      decoded = __atob(str);
    }
    return {
      toString: function() { return decoded; }
    };
  }
};

// Determinism: freeze Date to a constant — bypasses timing-based anti-tamper
(function() {
  var FROZEN_TIME = 1700000000000;
  var OrigDate = Date;
  var FrozenDate = function() {
    if (arguments.length === 0) return new OrigDate(FROZEN_TIME);
    return new (Function.prototype.bind.apply(OrigDate, [null].concat(Array.prototype.slice.call(arguments))))();
  };
  FrozenDate.now = function() { return FROZEN_TIME; };
  FrozenDate.parse = OrigDate.parse;
  FrozenDate.UTC = OrigDate.UTC;
  FrozenDate.prototype = OrigDate.prototype;
  Date = FrozenDate;
})();

// Determinism: seeded xorshift32 PRNG — reproducible Math.random()
(function() {
  var seed = 0x2F6E2B1;
  Math.random = function() {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
})();
`;

export function executeSandboxed(code: string, timeout = 5000): string {
  if (code.length > MAX_CODE_SIZE) {
    throw new Error(`Input code exceeds ${MAX_CODE_SIZE} byte limit (${code.length} bytes)`);
  }

  const effectiveTimeout = Math.min(timeout, MAX_TIMEOUT);

  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = isolate.createContextSync();
    const jail = context.global;

    // Set up output capture callback with size cap
    let output = "";
    let outputCapped = false;
    jail.setSync("__write", new ivm.Callback((str: string) => {
      if (outputCapped) throw new Error("Output buffer limit exceeded");
      if (output.length + str.length > MAX_OUTPUT_BYTES) {
        outputCapped = true;
        throw new Error("Output buffer limit exceeded");
      }
      output += str;
    }));

    // Set up base64 callbacks with input size cap
    jail.setSync("__atob", new ivm.Callback((str: string) => {
      if (str.length > MAX_BASE64_INPUT) {
        throw new Error("Base64 input exceeds size limit");
      }
      return Buffer.from(str, "base64").toString("binary");
    }));
    jail.setSync("__btoa", new ivm.Callback((str: string) => {
      if (str.length > MAX_BASE64_INPUT) {
        throw new Error("Base64 input exceeds size limit");
      }
      return Buffer.from(str, "binary").toString("base64");
    }));

    // Inject preamble (process shim, Buffer polyfill, etc.)
    const preambleScript = isolate.compileScriptSync(ISOLATE_PREAMBLE);
    preambleScript.runSync(context);

    // Compile and run user code with timeout
    const userScript = isolate.compileScriptSync(code);
    userScript.runSync(context, { timeout: effectiveTimeout });

    return output;
  } finally {
    isolate.dispose();
  }
}
