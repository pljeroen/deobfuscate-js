/**
 * CLI entry point — reads minified JS from input/, runs the
 * de-obfuscation pipeline, writes output to output/.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPipeline } from "./pipeline.js";
import { formatPass } from "./passes/format.js";
import { simplifyPass } from "./passes/simplify.js";
import { renamePass } from "./passes/rename.js";

const inputPath = process.argv[2] ?? resolve("input/lodash.min.js");
const outputPath = process.argv[3] ?? resolve("output/lodash.deobfuscated.js");

const source = readFileSync(inputPath, "utf-8");

const result = runPipeline(source, [
  simplifyPass,
  renamePass,
  formatPass,
]);

writeFileSync(outputPath, result, "utf-8");

const inputSize = Buffer.byteLength(source);
const outputSize = Buffer.byteLength(result);
console.log(`Done: ${inputPath} (${inputSize} bytes) → ${outputPath} (${outputSize} bytes)`);
