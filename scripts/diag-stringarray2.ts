import { parse, generate } from "../src/parser.js";
import { readFileSync } from "node:fs";
import { t } from "../src/babel.js";

const source = readFileSync("benchmarks/jsdeobsbench/build_dataset/codenet_dataset_deadcode-injection/codenet_p02772_1.obf.js", "utf-8");
import { hexDecodePass } from "../src/passes/hex-decode.js";

let ast = parse(source);
ast = hexDecodePass.run(ast);
const hexSource = generate(ast);
ast = parse(hexSource);

// Manually call detectPattern equivalent
const body = ast.program.body;

// Step 1: String array
let arrayName: string | null = null;
let arrayIdx = -1;

function isAllStringLiterals(arr: any): boolean {
  return arr.elements.every((el: any) => t.isStringLiteral(el));
}
function isSelfOverwritingArrayFn(stmt: any): boolean {
  if (!stmt.id) return false;
  const fnName = stmt.id.name;
  const stmts = stmt.body.body;
  let hasStringArray = false;
  let hasSelfAssign = false;
  for (const s of stmts) {
    if (t.isVariableDeclaration(s)) {
      for (const d of s.declarations) {
        if (t.isArrayExpression(d.init) && isAllStringLiterals(d.init) && d.init.elements.length >= 3) {
          hasStringArray = true;
        }
      }
    }
    if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) &&
        t.isIdentifier(s.expression.left) && s.expression.left.name === fnName) {
      hasSelfAssign = true;
    }
  }
  return hasStringArray && hasSelfAssign;
}

for (let i = 0; i < body.length; i++) {
  const stmt = body[i];
  if (t.isVariableDeclaration(stmt)) {
    for (const decl of stmt.declarations) {
      if (t.isIdentifier(decl.id) && t.isArrayExpression(decl.init) &&
          isAllStringLiterals(decl.init) && decl.init.elements.length >= 3) {
        arrayName = decl.id.name;
        arrayIdx = i;
      }
    }
  }
  if (!arrayName && t.isFunctionDeclaration(stmt) && t.isIdentifier(stmt.id) &&
      isSelfOverwritingArrayFn(stmt)) {
    arrayName = stmt.id.name;
    arrayIdx = i;
  }
  if (arrayName) break;
}
console.log("Array:", arrayName, "at index", arrayIdx);

// Step 2: Decoders
import _generate from "@babel/generator";
const generateNode: typeof _generate = (_generate as any).default ?? _generate;
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

for (let i = 0; i < body.length; i++) {
  if (i === arrayIdx) continue;
  const stmt = body[i];
  if (t.isFunctionDeclaration(stmt) && stmt.id) {
    const fnBody = generateNode(stmt.body as any).code;
    const re = new RegExp(`\\b${escapeRegExp(arrayName!)}\\b`);
    const contains = re.test(fnBody);
    console.log(`body[${i}] ${stmt.id.name}: contains ${arrayName}: ${contains}`);
  }
}

// Now try running the actual string-array pass with error logging
import { stringArrayPass } from "../src/passes/string-array.js";
ast = parse(hexSource);
try {
  const before = generate(ast);
  ast = stringArrayPass.run(ast, hexSource);
  const after = generate(ast);
  console.log("\nPass changed:", before !== after);
  if (before === after) {
    console.log("NO CHANGE — checking if detectPattern returned null...");
  }
} catch (e: any) {
  console.log("PASS ERROR:", e.message);
}
