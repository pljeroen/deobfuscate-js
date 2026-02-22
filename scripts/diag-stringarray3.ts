import { parse, generate } from "../src/parser.js";
import { readFileSync } from "node:fs";
import { hexDecodePass } from "../src/passes/hex-decode.js";

const source = readFileSync("benchmarks/jsdeobsbench/build_dataset/codenet_dataset_deadcode-injection/codenet_p02772_1.obf.js", "utf-8");
let ast = parse(source);
ast = hexDecodePass.run(ast);
const hexSource = generate(ast);

// Monkey-patch string-array to add logging
import { stringArrayPass } from "../src/passes/string-array.js";

// Run the pass and catch the actual error
const origRun = stringArrayPass.run.bind(stringArrayPass);

// Wrap to add error logging
const before = generate(ast);
try {
  ast = parse(hexSource);
  // We need to see what happens inside. Let's just run it and check
  ast = stringArrayPass.run(ast, hexSource);
  const after = generate(ast);
  console.log("Changed:", before !== after);
} catch (e: any) {
  console.log("ERROR:", e.message);
  console.log("STACK:", e.stack?.substring(0, 500));
}
