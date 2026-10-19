/**
 * CLI entry point — reads JS from the input path, runs the de-obfuscation
 * pipeline, and writes the result to the output path.
 *
 * Every refusal ends the run with exit status 1 and exactly one "ERROR:" line
 * as the last stderr line; refusals decided before the write leave the output
 * untouched. All file access goes through src/cli/safe-output.ts; the pipeline
 * itself performs no I/O. The exit status is set through process.exitCode and
 * the script returns normally, so stderr is always delivered completely.
 */

import { resolve } from "node:path";
import { runPipelineWithReport, filterSafePasses, warningsOf } from "./pipeline.js";
import type { PipelineResult } from "./pipeline.js";
import type { ASTPass } from "./types.js";
import { MAX_INPUT_BYTES, openInput, readInput, closeInput, statTarget, identityDecision, guardedWrite } from "./cli/safe-output.js";
import type { FileId, InputHandle, SafeFailure } from "./cli/safe-output.js";
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
import { formatPass } from "./passes/format.js";

const args = process.argv.slice(2);
const unsafeMode = args.includes("--unsafe");
const verboseMode = args.includes("--verbose");
const positionalArgs = args.filter(a => !a.startsWith("--"));

const inputPath = positionalArgs[0] ?? resolve("input/lodash.min.js");
const outputPath = positionalArgs[1] ?? resolve("output/lodash.deobfuscated.js");

const allASTPasses: ASTPass[] = [bundlerUnpackPass, constantFoldPass, constantPropagatePass, deadCodeEliminatePass, hexDecodePass, stringArrayStaticPass, stringArrayPass, controlFlowObjectPass, controlFlowUnflattenPass, constantFoldPass, deadCodeEliminatePass, antiDebugPass, constantPropagatePass, deadCodeEliminatePass, astSimplifyPass, semanticRenamePass, astRenamePass];

const astPasses = unsafeMode ? allASTPasses : filterSafePasses(allASTPasses);

/** What the run has produced so far; the internal-error handler reports from it. */
interface RunState {
  runnerStarted: boolean;
  result?: PipelineResult;
  warningsPrinted: boolean;
  reportPrinted: boolean;
}

/** A step either yields a value or the text of the refusal that ends the run. */
type Step<T> = { ok: true; value: T } | { ok: false; refusal: string };

function refusal<T>(text: string): Step<T> {
  return { ok: false, refusal: text };
}

function stderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Collapse line breaks so one message stays one physical stderr line. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** End the run with the single ERROR line (always the last stderr line) and status 1. */
function refuse(text: string): void {
  stderrLine(`ERROR: ${oneLine(text)}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// ERROR line texts: each names the affected path(s) and the OS code when one is involved
// ---------------------------------------------------------------------------

const INPUT_REASONS: Record<string, string> = {
  ENOENT: "not found",
  EACCES: "permission denied",
  EPERM: "permission denied",
  EISDIR: "is a directory",
};

function inputText(failure: SafeFailure): string {
  const why = (failure.code !== undefined ? INPUT_REASONS[failure.code] : undefined) ?? `${failure.op ?? "read"} error`;
  return `Cannot read input file ${failure.path}: ${why}${failure.code === undefined ? "" : ` (${failure.code})`}`;
}

function sizeText(failure: SafeFailure): string {
  return `Input file exceeds max size: ${failure.path}: ${failure.detail} (max: ${MAX_INPUT_BYTES} bytes / 20MB)`;
}

function sameFileText(atOpen: boolean): string {
  const when = atOpen ? " (found when opening the output)" : "";
  return `Input and output are the same file${when}: input ${inputPath}, output ${outputPath}; nothing was written`;
}

function unverifiedText(op: string, code: string | undefined, side: "input" | "output" | undefined): string {
  const subject = side === "input" ? `output ${outputPath} is not the input file ${inputPath}` : `output ${outputPath} is not the input file`;
  return `Cannot verify that ${subject} (${op}${code === undefined ? "" : `: ${code}`}); nothing was written`;
}

function writeText(failure: SafeFailure): string {
  const cause = failure.code ?? failure.detail ?? "unknown cause";
  const text = `Writing output failed: ${failure.path} (${failure.op ?? "write"}: ${cause})`;
  return failure.stage === "WPOST" ? `${text}; the output may be empty or partial` : `${text}; nothing was written to the output`;
}

function writeFailureText(failure: SafeFailure): string {
  if (failure.reason === "SAME") return sameFileText(true);
  if (failure.reason === "IDUNK") return unverifiedText(failure.op ?? "fstat", failure.code, failure.side);
  return writeText(failure);
}

/** Parse and emptiness refusals, decided from the structured pipeline result. */
function pipelineRefusal(result: PipelineResult): string | undefined {
  const parsed = result.initialParse;
  if (parsed.completeness === "empty") {
    const line = parsed.truncatedAtLine === undefined ? "" : ` (syntax error at line ${parsed.truncatedAtLine})`;
    return `Input could not be parsed: ${inputPath}${line}; nothing was written`;
  }
  if (parsed.completeness === "truncated") {
    return `Input was only partially parsed: ${inputPath} (syntax error at line ${parsed.truncatedAtLine}); nothing was written`;
  }
  if (result.inputStatementCount > 0 && result.finalStatementCount === 0) {
    return `All statements were removed from the non-empty input ${inputPath}; nothing was written`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// stderr classes after the notice: pipeline warnings, then the --verbose report
// ---------------------------------------------------------------------------

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    stderrLine(`WARNING: ${oneLine(warning)}`);
  }
}

function printReport(result: PipelineResult): void {
  process.stderr.write(`\nPipeline: ${result.iterations} iteration(s), entropy ${result.initialEntropy.toFixed(2)} → ${result.finalEntropy.toFixed(2)}\n`);
  process.stderr.write("Pass report:\n");
  for (const entry of result.report) {
    process.stderr.write(`  ${entry.name}: ${entry.changed ? "changed" : "no change"}\n`);
  }
}

// ---------------------------------------------------------------------------
// main flow
// ---------------------------------------------------------------------------

/**
 * Same-file check, directory refusal and bounded read on the open input
 * descriptor, in that order: a same-file input is never read.
 */
function checkAndRead(handle: InputHandle): Step<Buffer> {
  const target = statTarget(outputPath);
  const early = identityDecision(handle.id, target, inputPath, outputPath);
  if (early.decision === "Same") return refusal(sameFileText(false));
  // a failing stat of the output, or (ino 0 only) a failing realpath
  if (early.decision === "Unknown") return refusal(unverifiedText(target.ok ? "realpath" : "stat", early.code, early.side));
  if (handle.kind === "directory") return refusal(`Cannot read input file ${inputPath}: is a directory (EISDIR)`);

  const read = readInput(handle, { maxBytes: MAX_INPUT_BYTES });
  if (!read.ok) return refusal(read.error.reason === "SIZE" ? sizeText(read.error) : inputText(read.error));
  return { ok: true, value: read.value };
}

function loadInput(): Step<{ id: FileId; bytes: Buffer }> {
  const opened = openInput(inputPath);
  if (!opened.ok) return refusal(inputText(opened.error));
  const handle = opened.value;
  const read = checkAndRead(handle);
  closeInput(handle);
  return read.ok ? { ok: true, value: { id: handle.id, bytes: read.value } } : read;
}

function main(state: RunState): void {
  if (unsafeMode) {
    stderrLine("WARNING: Unsafe mode enabled — string-array pass will execute untrusted code");
  }

  const input = loadInput();
  if (!input.ok) return refuse(input.refusal);

  const source = input.value.bytes.toString("utf-8");
  state.runnerStarted = true;
  const result = runPipelineWithReport(source, astPasses, [formatPass]);
  state.result = result;

  printWarnings(result.warnings);
  state.warningsPrinted = true;
  if (verboseMode) {
    printReport(result);
    state.reportPrinted = true;
  }

  const refused = pipelineRefusal(result);
  if (refused !== undefined) return refuse(refused);

  const { code } = result;
  const written = guardedWrite(outputPath, Buffer.from(code, "utf-8"), input.value.id, inputPath);
  if (!written.ok) return refuse(writeFailureText(written.error));

  const inputSize = Buffer.byteLength(source);
  const outputSize = Buffer.byteLength(code);
  const done = `Done: ${inputPath} (${inputSize} bytes) → ${outputPath} (${outputSize} bytes)`;
  // When the output is the process stdout itself, the status line must not land in it.
  if (written.value.doneToStderr) stderrLine(done);
  else console.log(done);
}

// ---------------------------------------------------------------------------
// unexpected internal errors
// ---------------------------------------------------------------------------

function printable(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function describeThrown(thrown: unknown): { message: string; code?: string; frames: string[] } {
  const message = thrown instanceof Error ? thrown.message : printable(thrown);
  if (typeof thrown !== "object" || thrown === null) return { message, frames: [] };
  const { code, stack } = thrown as { code?: unknown; stack?: unknown };
  const frames = typeof stack === "string" ? stack.split("\n").filter((l) => /^\s+at /.test(l)) : [];
  return { message, frames, ...(typeof code === "string" ? { code } : {}) };
}

/**
 * Report an exception that no refusal or pass skip absorbed: the warnings
 * available, then (with --verbose) the report and the stack frames, then one
 * "ERROR: internal error: ..." line.
 */
function reportInternalError(thrown: unknown, state: RunState): void {
  if (!state.warningsPrinted) {
    // the runner attaches its warnings to what it throws
    const available = state.result?.warnings ?? (state.runnerStarted ? warningsOf(thrown) : []);
    printWarnings(available);
  }
  const { message, code, frames } = describeThrown(thrown);
  if (verboseMode) {
    if (state.result !== undefined && !state.reportPrinted) printReport(state.result);
    for (const frame of frames) stderrLine(frame);
  }
  refuse(`internal error: ${inputPath}: ${code === undefined ? "" : `${code}: `}${message}`);
}

const state: RunState = { runnerStarted: false, warningsPrinted: false, reportPrinted: false };
try {
  main(state);
} catch (thrown: unknown) {
  reportInternalError(thrown, state);
}
