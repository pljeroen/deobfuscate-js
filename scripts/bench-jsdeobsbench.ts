/**
 * JsDeObsBench adapter — runs our deobfuscation pipeline against
 * JsDeObsBench JSONL dataset format.
 *
 * Usage:
 *   npx tsx scripts/bench-jsdeobsbench.ts --input <path.jsonl> --output <path.jsonl> [--unsafe]
 *
 * Input JSONL fields: filename, original, obfuscated, test_cases, language
 * Output JSONL: same records with `deobfuscated` field added.
 *
 * `deobfuscated` is what the CLI (src/index.ts) writes, in the same mode, for a
 * file holding the record's `obfuscated` text: the CLI's pass list and pipeline,
 * or an empty text where the CLI writes nothing (input over the size limit,
 * input that could not be parsed, was only partially parsed or lost all its
 * statements, an internal error). A record whose `deobfuscated` is empty, an
 * empty input included, counts as a failure and gets one
 * "Error on <filename>: <reason>" line on stderr; a pass skipped after an error
 * is not a failure. Each warning the CLI would print for a record is shown as a
 * "Warning on <filename>: <warning>" line. Each such line is kept on one line:
 * line breaks in it, the filename's included, become one space.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { runPipelineWithReport, filterSafePasses, warningsOf } from "../src/pipeline.js";
import type { PipelineResult } from "../src/pipeline.js";
import { MAX_INPUT_BYTES } from "../src/cli/safe-output.js";
import { allASTPasses, pipelineRefusalOf, oneLine } from "../src/cli-shared.js";
import { formatPass } from "../src/passes/format.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const inputPath = getArg("--input");
const outputPath = getArg("--output");
const unsafeMode = args.includes("--unsafe");

if (!inputPath || !outputPath) {
  process.stderr.write("Usage: npx tsx scripts/bench-jsdeobsbench.ts --input <path.jsonl> --output <path.jsonl> [--unsafe]\n");
  process.exit(1);
}

const astPasses = unsafeMode ? allASTPasses : filterSafePasses(allASTPasses);

/** What the CLI writes for a file holding a record's text, the warnings it prints, and why it writes nothing. */
interface Outcome {
  code: string;
  warnings: string[];
  failure?: string;
}

function thrownMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** The reason the CLI refuses a pipeline result, in its words; undefined when it writes the code. */
function refusalReason(result: PipelineResult): string | undefined {
  const refused = pipelineRefusalOf(result);
  if (refused?.kind === "unparsed") {
    return `input could not be parsed${refused.syntaxErrorLine === undefined ? "" : ` (syntax error at line ${refused.syntaxErrorLine})`}`;
  }
  if (refused?.kind === "partly-parsed") return `input was only partially parsed (syntax error at line ${refused.syntaxErrorLine})`;
  if (refused?.kind === "emptied") {
    const by = result.emptiedBy === undefined ? "" : ` by the ${result.emptiedBy.name} pass (iteration ${result.emptiedBy.iteration})`;
    return `all statements were removed from the non-empty input${by}`;
  }
  return undefined;
}

function deobfuscate(text: string): Outcome {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.length > MAX_INPUT_BYTES) {
    return { code: "", warnings: [], failure: `input exceeds max size: ${bytes.length} bytes (max: ${MAX_INPUT_BYTES} bytes / 20MB)` };
  }
  let result: PipelineResult;
  try {
    result = runPipelineWithReport(bytes.toString("utf-8"), astPasses, [formatPass]);
  } catch (thrown: unknown) {
    return { code: "", warnings: warningsOf(thrown), failure: `internal error: ${thrownMessage(thrown)}` };
  }
  const refused = refusalReason(result);
  if (refused !== undefined) return { code: "", warnings: result.warnings, failure: refused };
  if (result.code === "") return { code: "", warnings: result.warnings, failure: text.trim() === "" ? "empty input" : "empty output" };
  return { code: result.code, warnings: result.warnings };
}

// The progress line is rewritten in place with "\r"; a line printed after it starts on a new line.
let progressShown = false;
function stderrLine(line: string): void {
  process.stderr.write(`${progressShown ? "\n" : ""}${line}\n`);
  progressShown = false;
}

const lines = readFileSync(inputPath, "utf-8").trim().split("\n");
const total = lines.length;
let failures = 0;
let warned = 0;
const outputLines: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const record = JSON.parse(lines[i]);
  const obfuscated: string = record.obfuscated ?? "";

  const outcome = deobfuscate(obfuscated);
  for (const warning of outcome.warnings) stderrLine(oneLine(`Warning on ${record.filename}: ${warning}`));
  if (outcome.warnings.length > 0) warned++;
  if (outcome.failure !== undefined) {
    failures++;
    stderrLine(oneLine(`Error on ${record.filename}: ${outcome.failure}`));
  }

  record.deobfuscated = outcome.code;
  outputLines.push(JSON.stringify(record));

  if ((i + 1) % 10 === 0 || i + 1 === total) {
    process.stderr.write(`\r[${i + 1}/${total}] ${failures} failures`);
    progressShown = true;
  }
}

process.stderr.write("\n");
writeFileSync(outputPath, outputLines.join("\n") + "\n");
process.stderr.write(`Done: ${total} samples, ${failures} failures, ${warned} records with warnings -> ${outputPath}\n`);
