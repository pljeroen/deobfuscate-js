/**
 * Process-isolated JavaScript execution sandbox.
 *
 * Spawns a child Node.js process to execute untrusted code.
 * Provides OS-level process isolation: separate address space,
 * enforced timeout via SIGTERM.
 *
 * WARNING: This is NOT a security sandbox. While require() is blocked
 * via module wrapper override, a determined attacker could bypass this.
 * Only use on code you are willing to execute. The string-array pass
 * that uses this is marked safety: "unsafe" and requires --unsafe flag.
 */

import { execFileSync } from "child_process";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Maximum sandbox timeout to prevent DoS (15 seconds) */
const MAX_TIMEOUT = 15000;

/**
 * Preamble injected before user code to restrict dangerous operations.
 * Blocks require() for fs, child_process, net, http, https, dgram, cluster, worker_threads.
 * This is defense-in-depth, not a security boundary.
 */
const SANDBOX_PREAMBLE = `
(function() {
  var _origRequire = typeof require !== 'undefined' ? require : null;
  var _blocked = new Set([
    'fs', 'child_process', 'net', 'http', 'https', 'http2',
    'dgram', 'cluster', 'worker_threads', 'vm', 'v8',
    'fs/promises', 'node:fs', 'node:child_process', 'node:net',
    'node:http', 'node:https', 'node:http2', 'node:dgram',
    'node:cluster', 'node:worker_threads', 'node:vm', 'node:v8',
    'node:fs/promises',
  ]);
  if (typeof require !== 'undefined') {
    var _Module = require('module');
    var _origResolve = _Module._resolveFilename;
    _Module._resolveFilename = function(request) {
      if (_blocked.has(request)) {
        throw new Error('Module "' + request + '" is blocked in sandbox');
      }
      return _origResolve.apply(this, arguments);
    };
  }
  // Block process.env access beyond what we set
  if (typeof process !== 'undefined') {
    Object.defineProperty(process, 'env', {
      value: Object.freeze(Object.assign({}, process.env)),
      writable: false, configurable: false
    });
  }
})();
`;

export function executeSandboxed(code: string, timeout = 5000): string {
  // Enforce timeout ceiling
  const effectiveTimeout = Math.min(timeout, MAX_TIMEOUT);

  const dir = mkdtempSync(join(tmpdir(), "deobf-"));
  const file = join(dir, "eval.js");
  // Write preamble + user code with restricted permissions (owner read/write only)
  writeFileSync(file, SANDBOX_PREAMBLE + code, { mode: 0o600 });
  try {
    return execFileSync(process.execPath, [
      "--no-warnings",
      "--disallow-code-generation-from-strings",
      file,
    ], {
      timeout: effectiveTimeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      // Restrict child environment: clear env vars that could leak paths/credentials
      env: {
        NODE_PATH: "",
        HOME: dir,
        TMPDIR: dir,
        PATH: process.env.PATH,
      },
    });
  } finally {
    // R07: Use recursive removal — child may have created files in temp dir
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
  }
}
