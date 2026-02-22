import { parse, generate } from "../src/parser.js";
import { readFileSync } from "node:fs";
import { traverse, t } from "../src/babel.js";

const source = readFileSync("benchmarks/jsdeobsbench/build_dataset/codenet_dataset_deadcode-injection/codenet_p02772_1.obf.js", "utf-8");

import { hexDecodePass } from "../src/passes/hex-decode.js";
let ast = parse(source);
ast = hexDecodePass.run(ast);
const hexSource = generate(ast);
ast = parse(hexSource);

const body = ast.program.body;
console.log("Total body statements:", body.length);

for (let i = 0; i < body.length; i++) {
  const stmt = body[i];
  const type = stmt.type;
  let name = "";
  if (t.isFunctionDeclaration(stmt) && stmt.id) name = stmt.id.name;
  else if (t.isVariableDeclaration(stmt)) {
    name = stmt.declarations.map(d => t.isIdentifier(d.id) ? d.id.name : "?").join(", ");
  }
  else if (t.isExpressionStatement(stmt)) name = "(expression)";
  console.log(`body[${i}]: ${type} — ${name}`);
}

// Manually check isSelfOverwritingArrayFn for body[1]
function isAllStringLiterals(arr: any): boolean {
  return arr.elements.every((el: any) => t.isStringLiteral(el));
}

for (let i = 0; i < body.length; i++) {
  const stmt = body[i];
  if (!t.isFunctionDeclaration(stmt) || !stmt.id) continue;
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
  console.log(`\nFn ${fnName}: hasStringArray=${hasStringArray}, hasSelfAssign=${hasSelfAssign}`);
}
