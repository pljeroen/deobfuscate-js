/**
 * JsDeObsBench adapter — runs our deobfuscation pipeline against
 * JsDeObsBench JSONL dataset format.
 *
 * Usage:
 *   npx tsx scripts/bench-jsdeobsbench.ts --input <path.jsonl> --output <path.jsonl> [--unsafe]
 *
 * Input JSONL fields: filename, original, obfuscated, test_cases, language
 * Output JSONL: same records with `deobfuscated` field added.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { runPipeline, filterSafePasses } from "../src/pipeline.js";
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

const allASTPasses: ASTPass[] = [
  bundlerUnpackPass, constantFoldPass, constantPropagatePass, deadCodeEliminatePass,
  hexDecodePass, stringArrayStaticPass, stringArrayPass, controlFlowObjectPass,
  controlFlowUnflattenPass, antiDebugPass, constantPropagatePass, deadCodeEliminatePass,
  astSimplifyPass, semanticRenamePass, astRenamePass,
];

const astPasses = unsafeMode ? allASTPasses : filterSafePasses(allASTPasses);

const lines = readFileSync(inputPath, "utf-8").trim().split("\n");
const total = lines.length;
let failures = 0;
const outputLines: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const record = JSON.parse(lines[i]);
  const obfuscated: string = record.obfuscated ?? "";

  let deobfuscated = "";
  try {
    deobfuscated = runPipeline(obfuscated, astPasses, [formatPass]);
  } catch (err) {
    failures++;
    process.stderr.write(`\nError on ${record.filename}: ${err}\n`);
  }

  record.deobfuscated = deobfuscated;
  outputLines.push(JSON.stringify(record));

  if ((i + 1) % 10 === 0 || i + 1 === total) {
    process.stderr.write(`\r[${i + 1}/${total}] ${failures} failures`);
  }
}

process.stderr.write("\n");
writeFileSync(outputPath, outputLines.join("\n") + "\n");
process.stderr.write(`Done: ${total} samples, ${failures} failures -> ${outputPath}\n`);
