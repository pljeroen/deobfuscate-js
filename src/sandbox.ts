/**
 * V8 isolate sandbox using isolated-vm.
 *
 * Executes untrusted JavaScript in a genuine V8 isolate: separate heap,
 * no access to Node.js APIs (require, fs, net, process, etc.).
 *
 * Security properties:
 * - Memory limit enforced at the V8 level (128MB default)
 * - CPU timeout enforced via script.runSync({ timeout })
 * - No file system access (no temp files, no I/O)
 * - No network access
 * - No require/module system
 * - No process object (shimmed for stdout.write output only)
 *
 * Provides minimal shims for:
 * - process.stdout.write() — captures output
 * - Buffer.from(str, 'base64') — base64 decoding for obfuscator.io patterns
 * - atob/btoa — Web API base64
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
