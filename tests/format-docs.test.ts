/**
 * The documented format fallback (FORMAT-01 R-FM-11 AC-11.3, R-FM-15 AC-15.1):
 * the specification sheet lists both warning lines exactly as the code emits
 * them, and the README states the guarantee in the format pass section and in
 * one more Stability Guarantees bullet. The meaning of the wording is a review
 * item (AC-11.4, AC-15.2), not checked here.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import * as formatModule from "../src/passes/format.js";
import { CLI_FALLBACK_PREFIX, REASON_NOT_PROGRAM, REASON_NOT_SAME } from "./format-same-reference.js";
import type { PinnedFormatModule } from "./format-same-reference.js";

const ROOT = resolve(import.meta.dirname, "..");
const pinned = formatModule as unknown as PinnedFormatModule;

/** The lines of `text` from the heading line `heading` up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const all = text.split("\n");
  const start = all.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = /^#+/.exec(heading)![0].length;
  let end = start + 1;
  while (end < all.length && !(/^#+ /.test(all[end]) && /^#+/.exec(all[end])![0].length <= level)) end++;
  return all.slice(start, end).join("\n");
}

/** The number of Stability Guarantees bullets at the base tree (e3963d7). */
const STABILITY_BULLETS_AT_BASE = 3;

describe("docs/SPEC-SHEET.md section 5 (AC-11.3)", () => {
  it("lists both format warning lines, equal to the lines the code emits from its reason constants", () => {
    const streams = section(fs.readFileSync(join(ROOT, "docs", "SPEC-SHEET.md"), "utf-8"), "## 5. Streams");
    const reasons = pinned.FORMAT_FALLBACK_REASONS;
    expect(reasons).toEqual({ notSameProgram: REASON_NOT_SAME, inputNotProgram: REASON_NOT_PROGRAM });
    for (const reason of [reasons?.notSameProgram, reasons?.inputNotProgram]) {
      expect(streams).toContain(`${CLI_FALLBACK_PREFIX}${reason}`);
    }
  });
});

describe("README.md (AC-15.1)", () => {
  const readme = fs.readFileSync(join(ROOT, "README.md"), "utf-8");

  it("the format pass section names the unformatted fallback", () => {
    expect(section(readme, "#### Format (Token Phase)")).toContain("output left unformatted");
  });

  it("Stability Guarantees has exactly one more bullet than at the base tree", () => {
    const bullets = section(readme, "## Stability Guarantees").split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(STABILITY_BULLETS_AT_BASE + 1);
  });
});
