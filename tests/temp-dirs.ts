/**
 * Temporary directories for a test file, removed again when the file has run,
 * also after a failing test.
 *
 * Tests restrict modes on their fixtures (0000, 0200, 0500), so removal first
 * gives every directory in a tree mode 0700 and every regular file mode 0600.
 * The walk never follows a symlink, so nothing outside the tree is touched,
 * and FIFOs are never opened. A removal that still fails throws, after every
 * directory has been tried, so the run reports it.
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export class TempDirs {
  private readonly made: string[] = [];

  /** Create a fresh directory in os.tmpdir() whose name starts with `prefix`. */
  make(prefix: string): string {
    const dir = fs.mkdtempSync(join(tmpdir(), prefix));
    this.made.push(dir);
    return dir;
  }

  /** Remove every directory made so far. */
  removeAll(): void {
    const failures: unknown[] = [];
    for (let dir = this.made.pop(); dir !== undefined; dir = this.made.pop()) {
      try {
        if (!fs.existsSync(dir)) continue;
        restoreModes(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `could not remove ${failures.length} temporary director${failures.length === 1 ? "y" : "ies"}`);
  }
}

function restoreModes(dir: string): void {
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) restoreModes(path);
    else if (entry.isFile()) fs.chmodSync(path, 0o600);
  }
}
