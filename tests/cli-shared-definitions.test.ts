/**
 * The definitions the CLI shares with the two benchmark runners live once, in
 * src/cli-shared.ts: the CLI's AST pass list, the decision which refusal a
 * pipeline result gets, and the rule that keeps a message on one line.
 * src/index.ts and both runners import them from there.
 *
 * The module is loaded inside the tests (directly, or through readCliWiring),
 * never at the top of this file, so a missing module fails the tests that
 * need it instead of the whole file.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { ROOT, readCliWiring } from "./program-checks.js";
import type { ASTPass } from "../src/types.js";
import { bundlerUnpackPass } from "../src/passes/bundler-unpack.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { constantPropagatePass } from "../src/passes/constant-propagate.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { hexDecodePass } from "../src/passes/hex-decode.js";
import { stringArrayStaticPass } from "../src/passes/string-array-static.js";
import { stringArrayPass } from "../src/passes/string-array.js";
import { controlFlowObjectPass } from "../src/passes/control-flow-object.js";
import { controlFlowUnflattenPass } from "../src/passes/control-flow-unflatten.js";
import { antiDebugPass } from "../src/passes/anti-debug.js";
import { astSimplifyPass } from "../src/passes/ast-simplify.js";
import { semanticRenamePass } from "../src/passes/semantic-rename.js";
import { astRenamePass } from "../src/passes/ast-rename.js";

const SHARED_FILE = join(ROOT, "src", "cli-shared.ts");
const SHARED_SPECIFIER = "../src/cli-shared.js";

/** The CLI's AST passes in their order: the pass name and the object its own pass module exports. */
const CLI_PASSES: Array<[string, ASTPass]> = [
  ["bundler-unpack", bundlerUnpackPass],
  ["constant-fold", constantFoldPass],
  ["constant-propagate", constantPropagatePass],
  ["dead-code-eliminate", deadCodeEliminatePass],
  ["hex-decode", hexDecodePass],
  ["string-array-static", stringArrayStaticPass],
  ["string-array", stringArrayPass],
  ["control-flow-object", controlFlowObjectPass],
  ["control-flow-unflatten", controlFlowUnflattenPass],
  ["constant-fold", constantFoldPass],
  ["dead-code-eliminate", deadCodeEliminatePass],
  ["anti-debug", antiDebugPass],
  ["constant-propagate", constantPropagatePass],
  ["dead-code-eliminate", deadCodeEliminatePass],
  ["ast-simplify", astSimplifyPass],
  ["semantic-rename", semanticRenamePass],
  ["ast-rename", astRenamePass],
];

/** The parser's warning texts; a refusal must be decided from structured fields, never from these. */
const PARSER_TEXT = /Could not parse|Truncated at/;

describe("the definitions the CLI shares with the benchmark runners", () => {
  it("the CLI's AST pass list is these 17 passes in this order, each the object its own pass module exports", async () => {
    expect(fs.existsSync(SHARED_FILE), "src/cli-shared.ts exists").toBe(true);
    const { allASTPasses } = await readCliWiring();
    expect(allASTPasses.map((p) => p.name)).toEqual(CLI_PASSES.map(([name]) => name));
    expect(allASTPasses.map((p, i) => p === CLI_PASSES[i][1]), "each entry is the pass object of its own module").toEqual(CLI_PASSES.map(() => true));
  });

  it("no refusal decision in src/cli-shared.ts matches parser warning text", () => {
    // the pattern finds the warning texts where the parser writes them
    expect(fs.readFileSync(join(ROOT, "src", "parser.ts"), "utf-8")).toMatch(PARSER_TEXT);
    expect(fs.existsSync(SHARED_FILE), "src/cli-shared.ts exists").toBe(true);
    expect(fs.readFileSync(SHARED_FILE, "utf-8")).not.toMatch(PARSER_TEXT);
  });

  it("the one-line rule turns every line break, with the white space around it, into one space and keeps all other white space", async () => {
    expect(fs.existsSync(SHARED_FILE), "src/cli-shared.ts exists").toBe(true);
    const shared = (await import(/* @vite-ignore */ SHARED_SPECIFIER)) as { oneLine?: unknown };
    expect(typeof shared.oneLine, "src/cli-shared.ts exports oneLine").toBe("function");
    const oneLine = shared.oneLine as (text: string) => string;
    expect(oneLine("first  part\r\nsecond \n\n\t third\r\r fourth\t\nfifth \r\n")).toBe("first  part second third fourth fifth ");
  });
});
