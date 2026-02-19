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

export function executeSandboxed(code: string, timeout = 5000): string {
  const dir = mkdtempSync(join(tmpdir(), "deobf-"));
  const file = join(dir, "eval.js");
  writeFileSync(file, code);
  try {
    return execFileSync(process.execPath, ["--no-warnings", file], {
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } finally {
    try { unlinkSync(file); } catch { /* ignore cleanup errors */ }
    try { rmdirSync(dir); } catch { /* ignore cleanup errors */ }
  }
}
