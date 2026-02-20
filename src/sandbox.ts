/**
 * Process-isolated JavaScript execution sandbox.
 *
 * Spawns a child Node.js process to execute untrusted code.
 * Provides OS-level process isolation: separate address space,
 * enforced timeout via SIGTERM.
 */

import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Maximum sandbox timeout to prevent DoS (15 seconds) */
const MAX_TIMEOUT = 15000;

export function executeSandboxed(code: string, timeout = 5000): string {
  // Enforce timeout ceiling
  const effectiveTimeout = Math.min(timeout, MAX_TIMEOUT);

  const dir = mkdtempSync(join(tmpdir(), "deobf-"));
  const file = join(dir, "eval.js");
  // Write with restricted permissions (owner read/write only)
  writeFileSync(file, code, { mode: 0o600 });
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
    try { unlinkSync(file); } catch { /* ignore cleanup errors */ }
    try { rmdirSync(dir); } catch { /* ignore cleanup errors */ }
  }
}
