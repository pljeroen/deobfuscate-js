/**
 * Batch-mode JSONL deobfuscator for JsDeObsBench.
 *
 * Reads a dataset JSONL, deobfuscates every sample in-process (no per-sample
 * subprocess overhead), and writes the result JSONL.
 *
 * Usage:
 *   npx tsx scripts/bench-batch.ts <input.jsonl> <output.jsonl> [--unsafe]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runPipelineWithReport, filterSafePasses } from "../src/pipeline.js";
import type { ASTPass } from "../src/types.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { constantPropagatePass } from "../src/passes/constant-propagate.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { hexDecodePass } from "../src/passes/hex-decode.js";
import { astSimplifyPass } from "../src/passes/ast-simplify.js";
import { astRenamePass } from "../src/passes/ast-rename.js";
import { controlFlowObjectPass } from "../src/passes/control-flow-object.js";
import { controlFlowUnflattenPass } from "../src/passes/control-flow-unflatten.js";
import { stringArrayPass } from "../src/passes/string-array.js";
import { stringArrayStaticPass } from "../src/passes/string-array-static.js";
import { bundlerUnpackPass } from "../src/passes/bundler-unpack.js";
import { semanticRenamePass } from "../src/passes/semantic-rename.js";
import { antiDebugPass } from "../src/passes/anti-debug.js";
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

const allASTPasses: ASTPass[] = [
  bundlerUnpackPass, constantFoldPass, constantPropagatePass,
  deadCodeEliminatePass, hexDecodePass, stringArrayStaticPass,
  stringArrayPass, controlFlowObjectPass, controlFlowUnflattenPass,
  antiDebugPass, constantPropagatePass, deadCodeEliminatePass,
  astSimplifyPass, semanticRenamePass, astRenamePass,
];

const astPasses = unsafeMode ? allASTPasses : filterSafePasses(allASTPasses);

// Read JSONL
const lines = readFileSync(inputPath, "utf-8").split("\n").filter(l => l.trim());
const dataset = lines.map(l => JSON.parse(l));

process.stderr.write(`Processing ${dataset.length} samples (unsafe=${unsafeMode})...\n`);

let failCount = 0;
const startTime = Date.now();

for (let i = 0; i < dataset.length; i++) {
  const data = dataset[i];
  data.task_type = "deobfuscation";
  data.task_id = i;

  const obfCode: string = data.obfuscated ?? "";
  if (!obfCode.trim()) {
    data.deobfuscated = "";
    failCount++;
    continue;
  }

  try {
    const { code } = runPipelineWithReport(obfCode, astPasses, [formatPass]);
    data.deobfuscated = code;
  } catch {
    data.deobfuscated = "";
    failCount++;
  }

  // Progress every 50 samples
  if ((i + 1) % 50 === 0 || i === dataset.length - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = ((i + 1) / ((Date.now() - startTime) / 1000)).toFixed(1);
    process.stderr.write(`  ${i + 1}/${dataset.length} (${rate} samples/s, ${elapsed}s elapsed, ${failCount} failures)\n`);
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
process.stderr.write(`Done: ${dataset.length} samples in ${totalTime}s (${failCount} failures)\n`);

// Write output JSONL
mkdirSync(dirname(outputPath), { recursive: true });
const output = dataset.map(d => JSON.stringify(d)).join("\n") + "\n";
writeFileSync(outputPath, output, "utf-8");
process.stderr.write(`Written: ${outputPath}\n`);
