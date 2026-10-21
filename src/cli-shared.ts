/**
 * Definitions the CLI shares with the benchmark runners: the AST pass list,
 * the decision which pipeline refusal a result gets, and the rule that keeps
 * a message on one line. Importing this module runs nothing and performs no
 * I/O.
 */

import type { ASTPass } from "./types.js";
import type { PipelineResult } from "./pipeline.js";
import { constantFoldPass } from "./passes/constant-fold.js";
import { constantPropagatePass } from "./passes/constant-propagate.js";
import { deadCodeEliminatePass } from "./passes/dead-code-eliminate.js";
import { hexDecodePass } from "./passes/hex-decode.js";
import { astSimplifyPass } from "./passes/ast-simplify.js";
import { astRenamePass } from "./passes/ast-rename.js";
import { controlFlowObjectPass } from "./passes/control-flow-object.js";
import { controlFlowUnflattenPass } from "./passes/control-flow-unflatten.js";
import { stringArrayPass } from "./passes/string-array.js";
import { stringArrayStaticPass } from "./passes/string-array-static.js";
import { bundlerUnpackPass } from "./passes/bundler-unpack.js";
import { semanticRenamePass } from "./passes/semantic-rename.js";
import { antiDebugPass } from "./passes/anti-debug.js";

/** The CLI's AST passes in pipeline order (string-array is the one unsafe pass). */
export const allASTPasses: ASTPass[] = [bundlerUnpackPass, constantFoldPass, constantPropagatePass, deadCodeEliminatePass, hexDecodePass, stringArrayStaticPass, stringArrayPass, controlFlowObjectPass, controlFlowUnflattenPass, constantFoldPass, deadCodeEliminatePass, antiDebugPass, constantPropagatePass, deadCodeEliminatePass, astSimplifyPass, semanticRenamePass, astRenamePass];

/**
 * A pipeline refusal: nothing of the input parsed, only part of it parsed, or
 * a non-empty input left without statements. The caller words the message;
 * `syntaxErrorLine` is the line of the primary syntax error, when known.
 */
export type PipelineRefusal =
  | { kind: "unparsed"; syntaxErrorLine?: number }
  | { kind: "partly-parsed"; syntaxErrorLine?: number }
  | { kind: "emptied" };

/** The refusal a pipeline result gets, decided from its structured fields, never from warning text. */
export function pipelineRefusalOf(result: PipelineResult): PipelineRefusal | undefined {
  const parsed = result.initialParse;
  if (parsed.completeness === "empty") return { kind: "unparsed", syntaxErrorLine: parsed.truncatedAtLine };
  if (parsed.completeness === "truncated") return { kind: "partly-parsed", syntaxErrorLine: parsed.truncatedAtLine };
  if (result.inputStatementCount > 0 && result.finalStatementCount === 0) return { kind: "emptied" };
  return undefined;
}

/** Collapse line breaks so one message stays one physical stderr line. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}
