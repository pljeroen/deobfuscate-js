import { readFileSync } from "fs";
import { parse, generate } from "../src/parser.js";
import { bundlerUnpackPass } from "../src/passes/bundler-unpack.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { constantPropagatePass } from "../src/passes/constant-propagate.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { hexDecodePass } from "../src/passes/hex-decode.js";
import { stringArrayPass } from "../src/passes/string-array.js";

const src = readFileSync("input/webcrack-samples/obfuscator.io.js", "utf-8");
let ast = parse(src);

for (const pass of [bundlerUnpackPass, constantFoldPass, constantPropagatePass, deadCodeEliminatePass, hexDecodePass, stringArrayPass]) {
  ast = pass.run(ast, src);
}
console.log("=== After string-array (1305 bytes) ===");
console.log(generate(ast));
