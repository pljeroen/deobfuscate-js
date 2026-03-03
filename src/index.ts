/**
 * CLI entry point — reads minified JS from input/, runs the
 * de-obfuscation pipeline, writes output to output/.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runPipelineWithReport, filterSafePasses } from "./pipeline.js";
import type { ASTPass } from "./types.js";
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

if (unsafeMode) {
  process.stderr.write("WARNING: Unsafe mode enabled — string-array pass will execute untrusted code\n");
}

const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20MB
const inputStat = statSync(inputPath);
if (inputStat.size > MAX_INPUT_BYTES) {
  process.stderr.write(
    `ERROR: Input file exceeds max size: ${inputStat.size} bytes (max: ${MAX_INPUT_BYTES} bytes / 20MB)\n`
  );
  process.exit(1);
}

const source = readFileSync(inputPath, "utf-8");

const { code, warnings, report, iterations, initialEntropy, finalEntropy } = runPipelineWithReport(source, astPasses, [formatPass]);

writeFileSync(outputPath, code, "utf-8");

for (const warning of warnings) {
  process.stderr.write(`WARNING: ${warning}\n`);
}

if (verboseMode) {
  process.stderr.write(`\nPipeline: ${iterations} iteration(s), entropy ${initialEntropy.toFixed(2)} → ${finalEntropy.toFixed(2)}\n`);
  process.stderr.write("Pass report:\n");
  for (const entry of report) {
    process.stderr.write(`  ${entry.name}: ${entry.changed ? "changed" : "no change"}\n`);
  }
}

const inputSize = Buffer.byteLength(source);
const outputSize = Buffer.byteLength(code);
console.log(`Done: ${inputPath} (${inputSize} bytes) → ${outputPath} (${outputSize} bytes)`);
