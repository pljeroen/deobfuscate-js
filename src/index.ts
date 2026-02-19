/**
 * CLI entry point — reads minified JS from input/, runs the
 * de-obfuscation pipeline, writes output to output/.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPipeline } from "./pipeline.js";
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
import { formatPass } from "./passes/format.js";

const inputPath = process.argv[2] ?? resolve("input/lodash.min.js");
const outputPath = process.argv[3] ?? resolve("output/lodash.deobfuscated.js");

const source = readFileSync(inputPath, "utf-8");

const result = runPipeline(
  source,
  [bundlerUnpackPass, constantFoldPass, constantPropagatePass, deadCodeEliminatePass, hexDecodePass, stringArrayPass, controlFlowObjectPass, controlFlowUnflattenPass, astSimplifyPass, astRenamePass],
  [formatPass],
);

writeFileSync(outputPath, result, "utf-8");

const inputSize = Buffer.byteLength(source);
const outputSize = Buffer.byteLength(result);
console.log(`Done: ${inputPath} (${inputSize} bytes) → ${outputPath} (${outputSize} bytes)`);
