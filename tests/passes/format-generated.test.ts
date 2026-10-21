/**
 * Generated-input test of the format pass (FORMAT-01 R-FM-17, AC-17.1 to AC-17.4).
 *
 * A deterministic generator (tests/format-program-generator.ts: fixed literal
 * seeds, no dependency) composes
 * programs from the lexical forms the format pass must handle:
 *   - single- and multi-line comments in statement, block, expression and
 *     end-of-input positions, each ended by every line terminator kind
 *     (LF, CR, CRLF, LS, PS);
 *   - '/' after every token class the tokenizer distinguishes (division after
 *     numbers, strings, templates, regular expressions, identifiers, value
 *     keywords, property names including reserved words, ')', ']', '++', '--';
 *     a regular expression after '(' ',' '=' ':' '?' '[' '!' operators,
 *     keywords, '=>', '{', a statement start, the ')' of an if, while, for or
 *     with head, and the '}' of a function declaration);
 *   - nested templates holding strings, regexes, comments and braces;
 *   - non-ASCII and escaped identifiers next to keywords;
 *   - numeric separators in every literal form;
 *   - a hashbang.
 *
 * Every generated program: the pass returns the input or the same program
 * (AC-17.2). Every program of the no-fallback subset: the pass does not fall
 * back (AC-17.3). The no-fallback subset ends every statement explicitly
 * (';' or a block '}'), has no HTML-like comment, and puts '/' only in the
 * contexts listed above. The other programs add statements ended by line
 * breaks alone, HTML-like comments and '/' after the '}' of a block, object
 * literal, function or class expression; a fallback there is correct and is
 * listed, not failed.
 */

import { describe, it, expect } from "vitest";
import { formatPass } from "../../src/passes/format.js";
import { GOALS, parseUnder, referenceSame, resultOf } from "../format-same-reference.js";
import type { PinnedFormatPass } from "../format-same-reference.js";
import { LISTED_FORMS, PROGRAMS, SUBSET } from "../format-program-generator.js";

const fp = formatPass as unknown as PinnedFormatPass;

/** AC-17.1: the whole file stays within 10 s; the two program sweeps share that budget. */
const SWEEP_TIMEOUT = { allPrograms: 6000, subset: 4000 } as const;

describe("generated programs (R-FM-17)", () => {
  it("every generated text is a program, and every listed lexical form occurs in the no-fallback subset (AC-17.1, AC-17.4)", () => {
    const notPrograms = PROGRAMS.filter((p) => !GOALS.some((g) => parseUnder(p.text, g) !== undefined)).map((p) => p.id);
    expect(notPrograms).toEqual([]);

    const counts = new Map<string, number>(LISTED_FORMS.map((f) => [f, 0]));
    for (const p of SUBSET) for (const f of p.forms) counts.set(f, (counts.get(f) ?? 0) + 1);
    const missing = LISTED_FORMS.filter((f) => (counts.get(f) ?? 0) === 0);
    expect(missing).toEqual([]);
    expect(SUBSET.length).toBeGreaterThan(0);
    expect(PROGRAMS.length - SUBSET.length).toBeGreaterThan(0);
  });

  it("every generated program: the result is the input or the same program (AC-17.2)", () => {
    const failures: string[] = [];
    const fellBack: string[] = [];
    for (const p of PROGRAMS) {
      let y: string;
      try {
        y = fp.run(p.text);
      } catch (thrown) {
        failures.push(`${p.id}: the pass threw ${String(thrown)}; input ${JSON.stringify(p.text)}`);
        continue;
      }
      if (y === p.text) {
        if (!p.inSubset) fellBack.push(p.id);
        continue;
      }
      const verdict = referenceSame(p.text, y);
      if (!verdict.same) failures.push(`${p.id}: ${verdict.detail}; input ${JSON.stringify(p.text)}`);
    }
    if (fellBack.length > 0) console.info(`format generated input: ${fellBack.length} programs outside the no-fallback subset were left unformatted: ${fellBack.join(", ")}`);
    expect({ count: failures.length, first: failures.slice(0, 5) }).toEqual({ count: 0, first: [] });
  }, SWEEP_TIMEOUT.allPrograms);

  it("every program of the no-fallback subset is formatted, not left unformatted (AC-17.3)", () => {
    const failures: string[] = [];
    for (const p of SUBSET) {
      let result: ReturnType<typeof resultOf>;
      try {
        result = resultOf(fp, p.text);
      } catch (thrown) {
        failures.push(`${p.id}: the pass threw ${String(thrown)}; input ${JSON.stringify(p.text)}`);
        continue;
      }
      if (typeof result === "string") {
        failures.push(result);
        break;
      }
      if (result.fallbackReason !== undefined) failures.push(`${p.id}: ${result.fallbackReason}; input ${JSON.stringify(p.text)}`);
    }
    expect({ count: failures.length, first: failures.slice(0, 5) }).toEqual({ count: 0, first: [] });
  }, SWEEP_TIMEOUT.subset);
});
