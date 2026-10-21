/**
 * Batch-mode JSONL deobfuscator for JsDeObsBench.
 *
 * Reads a dataset JSONL, deobfuscates every sample in-process (no per-sample
 * subprocess overhead), and writes the result JSONL.
 *
 * Usage:
 *   npx tsx scripts/bench-batch.ts <input.jsonl> <output.jsonl> [--unsafe]
 *
 * `deobfuscated` is what the CLI (src/index.ts) writes, in the same mode, for a
 * file holding the sample's `obfuscated` text: the CLI's pass list and pipeline,
 * or an empty text where the CLI writes nothing (input over the size limit,
 * input that could not be parsed, was only partially parsed or lost all its
 * statements, an internal error). A sample whose `deobfuscated` is empty, an
 * empty input included, counts as a failure and gets one
 * "Error on <filename>: <reason>" line on stderr; a pass skipped after an error
 * is not a failure. Each warning the CLI would print for a sample is shown as a
 * "Warning on <filename>: <warning>" line. Each such line is kept on one line:
 * line breaks in it, the filename's included, become one space.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runPipelineWithReport, filterSafePasses, warningsOf } from "../src/pipeline.js";
import type { PipelineResult } from "../src/pipeline.js";
import { MAX_INPUT_BYTES } from "../src/cli/safe-output.js";
import { allASTPasses, pipelineRefusalOf, oneLine } from "../src/cli-shared.js";
import { formatPass } from "../src/passes/format.js";

const args = process.argv.slice(2);
const unsafeMode = args.includes("--unsafe");
const positionalArgs = args.filter(a => !a.startsWith("--"));

if (positionalArgs.length < 2) {
  process.stderr.write("Usage: npx tsx scripts/bench-batch.ts <input.jsonl> <output.jsonl> [--unsafe]\n");
  process.exit(1);
}

const inputPath = positionalArgs[0];
const outputPath = positionalArgs[1];

const astPasses = unsafeMode ? allASTPasses : filterSafePasses(allASTPasses);

/** What the CLI writes for a file holding a sample's text, the warnings it prints, and why it writes nothing. */
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

// Read JSONL
const lines = readFileSync(inputPath, "utf-8").split("\n").filter(l => l.trim());
const dataset = lines.map(l => JSON.parse(l));

process.stderr.write(`Processing ${dataset.length} samples (unsafe=${unsafeMode})...\n`);

let failCount = 0;
let warnedCount = 0;
const startTime = Date.now();

for (let i = 0; i < dataset.length; i++) {
  const data = dataset[i];
  data.task_type = "deobfuscation";
  data.task_id = i;

  const obfCode: string = data.obfuscated ?? "";
  if (!obfCode.trim()) {
    // the CLI writes an empty output for an empty or whitespace-only input, with no warning
    data.deobfuscated = "";
    failCount++;
    process.stderr.write(oneLine(`Error on ${data.filename}: empty input`) + "\n");
    continue;
  }

  const outcome = deobfuscate(obfCode);
  for (const warning of outcome.warnings) process.stderr.write(oneLine(`Warning on ${data.filename}: ${warning}`) + "\n");
  if (outcome.warnings.length > 0) warnedCount++;
  if (outcome.failure !== undefined) {
    failCount++;
    process.stderr.write(oneLine(`Error on ${data.filename}: ${outcome.failure}`) + "\n");
  }
  data.deobfuscated = outcome.code;

  // Progress every 50 samples
  if ((i + 1) % 50 === 0 || i === dataset.length - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = ((i + 1) / ((Date.now() - startTime) / 1000)).toFixed(1);
    process.stderr.write(`  ${i + 1}/${dataset.length} (${rate} samples/s, ${elapsed}s elapsed, ${failCount} failures)\n`);
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
process.stderr.write(`Done: ${dataset.length} samples in ${totalTime}s (${failCount} failures, ${warnedCount} records with warnings)\n`);

// Write output JSONL
mkdirSync(dirname(outputPath), { recursive: true });
const output = dataset.map(d => JSON.stringify(d)).join("\n") + "\n";
writeFileSync(outputPath, output, "utf-8");
process.stderr.write(`Written: ${outputPath}\n`);
