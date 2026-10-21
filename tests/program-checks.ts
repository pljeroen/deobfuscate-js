/** Helpers for reading the shared CLI pass wiring and running the real CLI. */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ASTPass } from "../src/types.js";

export const ROOT = resolve(import.meta.dirname, "..");
export const ENTRY = join(ROOT, "src", "index.ts");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
export const SPAWN_TIMEOUT = 60000;
// ---------------------------------------------------------------------------
// the CLI's pass list
// ---------------------------------------------------------------------------

export interface CliWiring {
  /** the CLI's AST passes in their order, unsafe ones included */
  allASTPasses: ASTPass[];
  /** true when src/index.ts filters the list with filterSafePasses unless --unsafe is given */
  filtersUnsafe: boolean;
}

/** The module that defines the CLI's AST pass list; importing it runs nothing. */
const SHARED_FILE = join(ROOT, "src", "cli-shared.ts");
const SHARED_SPECIFIER = "../src/cli-shared.js";

/** True when `text` has a value import of `name` from the module specifier `from`. */
function importsName(text: string, name: string, from: string): boolean {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`, "g");
  for (const m of text.matchAll(declaration)) {
    if (m[1].split(",").map((s) => s.trim()).includes(name)) return true;
  }
  return false;
}

/**
 * Take the CLI's AST pass list from src/cli-shared.ts and check that
 * src/index.ts imports it from there. src/index.ts itself cannot be imported
 * (it runs the CLI when loaded), so its wiring is read as text.
 * The shared module is loaded here, not at the top of this file, so that a
 * file using only the other helpers loads without it.
 */
export async function readCliWiring(): Promise<CliWiring> {
  if (!fs.existsSync(SHARED_FILE)) throw new Error("src/cli-shared.ts does not exist");
  const text = fs.readFileSync(ENTRY, "utf-8");
  if (!importsName(text, "allASTPasses", "./cli-shared.js")) throw new Error("src/index.ts does not import allASTPasses from ./cli-shared.js");
  // the shared module imports each pass from its own src/passes module, so the tests share these instances
  const shared = (await import(/* @vite-ignore */ SHARED_SPECIFIER)) as Record<string, unknown>;
  const list = shared.allASTPasses;
  if (!Array.isArray(list) || list.length === 0) throw new Error("src/cli-shared.ts exports no non-empty allASTPasses list");
  for (const pass of list as Array<Partial<ASTPass> | undefined>) {
    if (pass === undefined || typeof pass.name !== "string" || typeof pass.run !== "function") throw new Error("src/cli-shared.ts allASTPasses holds an entry that is not a pass");
  }
  return {
    allASTPasses: [...(list as ASTPass[])],
    filtersUnsafe: /const astPasses = unsafeMode \? allASTPasses : filterSafePasses\(allASTPasses\);/.test(text),
  };
}

// ---------------------------------------------------------------------------
// the CLI as a subprocess
// ---------------------------------------------------------------------------

export interface CliRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdoutText: string;
  stderrLines: string[];
}

function lines(text: string): string[] {
  const l = text.split("\n");
  if (l.length > 0 && l[l.length - 1] === "") l.pop();
  return l;
}

/** Run the real entry point src/index.ts with the given arguments. */
export function runCli(args: string[]): CliRun {
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, ENTRY, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    timeout: SPAWN_TIMEOUT,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdoutText = ((r.stdout as Buffer | null) ?? Buffer.alloc(0)).toString("utf-8");
  const stderrText = ((r.stderr as Buffer | null) ?? Buffer.alloc(0)).toString("utf-8");
  return { status: r.status, signal: r.signal, stdoutText, stderrLines: lines(stderrText) };
}
