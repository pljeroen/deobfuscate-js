/**
 * CLI entry point — reads minified JS from input/, runs the
 * de-obfuscation pipeline, writes output to output/.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPipeline, filterSafePasses } from "./pipeline.js";
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
import { bundlerUnpackPass } from "./passes/bundler-unpack.js";
import { semanticRenamePass } from "./passes/semantic-rename.js";
import { antiDebugPass } from "./passes/anti-debug.js";
import { formatPass } from "./passes/format.js";

const args = process.argv.slice(2);
const unsafeMode = args.includes("--unsafe");
const positionalArgs = args.filter(a => !a.startsWith("--"));

const inputPath = positionalArgs[0] ?? resolve("input/lodash.min.js");
const outputPath = positionalArgs[1] ?? resolve("output/lodash.deobfuscated.js");

const allASTPasses: ASTPass[] = [bundlerUnpackPass, constantFoldPass, constantPropagatePass, deadCodeEliminatePass, hexDecodePass, stringArrayPass, controlFlowObjectPass, controlFlowUnflattenPass, antiDebugPass, constantPropagatePass, deadCodeEliminatePass, astSimplifyPass, semanticRenamePass, astRenamePass];

const astPasses = unsafeMode ? allASTPasses : filterSafePasses(allASTPasses);

if (unsafeMode) {
  process.stderr.write("WARNING: Unsafe mode enabled — string-array pass will execute untrusted code\n");
}

const source = readFileSync(inputPath, "utf-8");

const result = runPipeline(source, astPasses, [formatPass]);

writeFileSync(outputPath, result, "utf-8");

const inputSize = Buffer.byteLength(source);
const outputSize = Buffer.byteLength(result);
console.log(`Done: ${inputPath} (${inputSize} bytes) → ${outputPath} (${outputSize} bytes)`);
