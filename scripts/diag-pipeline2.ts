import { readFileSync } from "fs";
import { parse, generate } from "../src/parser.js";
import { bundlerUnpackPass } from "../src/passes/bundler-unpack.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { constantPropagatePass } from "../src/passes/constant-propagate.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { hexDecodePass } from "../src/passes/hex-decode.js";
import { stringArrayPass } from "../src/passes/string-array.js";
import { controlFlowObjectPass } from "../src/passes/control-flow-object.js";
import { controlFlowUnflattenPass } from "../src/passes/control-flow-unflatten.js";
import { antiDebugPass } from "../src/passes/anti-debug.js";

const src = readFileSync("input/webcrack-samples/obfuscator.io.js", "utf-8");
let ast = parse(src);

const passes = [
  bundlerUnpackPass, constantFoldPass, constantPropagatePass,
  deadCodeEliminatePass, hexDecodePass, stringArrayPass,
  controlFlowObjectPass, controlFlowUnflattenPass, antiDebugPass,
];

for (const pass of passes) {
  ast = pass.run(ast, src);
}
console.log("=== After anti-debug ===");
console.log(generate(ast));
