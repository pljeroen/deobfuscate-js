import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { t, traverse } from "../src/babel.js";
import { allASTPasses } from "../src/cli-shared.js";
import { generate, parse, parseWithDiagnostics } from "../src/parser.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { formatPass } from "../src/passes/format.js";
import { astRenamePass } from "../src/passes/ast-rename.js";
import { antiDebugPass } from "../src/passes/anti-debug.js";
import { constantFoldPass } from "../src/passes/constant-fold.js";
import { controlFlowObjectPass } from "../src/passes/control-flow-object.js";
import { bundlerUnpackPass } from "../src/passes/bundler-unpack.js";
import { constantPropagatePass } from "../src/passes/constant-propagate.js";
import { semanticRenamePass } from "../src/passes/semantic-rename.js";
import { filterSafePasses, runPipelineWithReport } from "../src/pipeline.js";

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = join(ROOT, "src", "index.ts");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const CLI_TIMEOUT_MS = 60_000;
const UNSAFE_NOTICE = "WARNING: Unsafe mode enabled — string-array pass will execute untrusted code";

type Execution =
  | { completion: "normal"; globals: Record<string, unknown> }
  | { completion: "throw"; errorName: string };

function executeFresh(source: string, observedGlobals: string[]): Execution {
  const context = vm.createContext(Object.create(null));
  try {
    vm.runInContext(source, context, { timeout: 2_000 });
    const globals = Object.fromEntries(
      observedGlobals.map((name) => [name, Reflect.get(context, name)]),
    );
    return { completion: "normal", globals };
  } catch (error: unknown) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name: unknown }).name)
        : typeof error;
    return { completion: "throw", errorName };
  }
}

function directCode(source: string): string {
  return generate(deadCodeEliminatePass.run(parse(source), source));
}

function astRenameCode(source: string): string {
  return generate(astRenamePass.run(parse(source), source));
}

function defaultPipeline(source: string): { code: string; warnings: string[] } {
  const result = runPipelineWithReport(source, filterSafePasses(allASTPasses), [formatPass]);
  return { code: result.code, warnings: result.warnings };
}

function directProgram(source: string): t.Program {
  return deadCodeEliminatePass.run(parse(source), source).program;
}

function expectDirectRetainedBlock(source: string, declarationType: "ClassDeclaration" | "FunctionDeclaration"): void {
  const body = directProgram(source).body;
  const block = body.find((statement) => t.isBlockStatement(statement));
  expect(block?.type).toBe("BlockStatement");
  expect(block?.body.some((statement) => statement.type === declarationType)).toBe(true);
}

function expectPipelineRetainedBlock(source: string, declarationType: "ClassDeclaration" | "FunctionDeclaration"): void {
  const pipeline = defaultPipeline(source);
  const block = parse(pipeline.code).program.body.find((statement) => t.isBlockStatement(statement));
  expect(pipeline.warnings).toEqual([]);
  expect(block?.type).toBe("BlockStatement");
  expect(block?.body.some((statement) => statement.type === declarationType)).toBe(true);
}

function outerFunctionBody(code: string): t.BlockStatement {
  const outer = parse(code).program.body.find((statement) => t.isFunctionDeclaration(statement));
  expect(outer?.type).toBe("FunctionDeclaration");
  return t.isFunctionDeclaration(outer) ? outer.body : t.blockStatement([]);
}

function expectRetainedAnnexBBlock(
  code: string,
  lexicalDeclarationExpectation: "present" | "absent" | "unconstrained",
): void {
  const selected = outerFunctionBody(code).body.find((statement) => t.isBlockStatement(statement));
  expect(selected?.type).toBe("BlockStatement");
  const selectedBody = t.isBlockStatement(selected) ? selected.body : [];
  expect(selectedBody.some((statement) => t.isFunctionDeclaration(statement))).toBe(true);
  if (lexicalDeclarationExpectation !== "unconstrained") {
    expect(selectedBody.some((statement) => t.isVariableDeclaration(statement) && statement.kind === "let"))
      .toBe(lexicalDeclarationExpectation === "present");
  }
}

function directFunctionBodyDeclarationCount(code: string): number {
  return outerFunctionBody(code).body.filter((statement) => t.isFunctionDeclaration(statement)).length;
}

function selectedNestedBlockFunctionDeclarationCount(code: string): number {
  const selected = outerFunctionBody(code).body.find((statement) => t.isBlockStatement(statement));
  return t.isBlockStatement(selected)
    ? selected.body.filter((statement) => t.isFunctionDeclaration(statement)).length
    : 0;
}

function directVariableNames(code: string): string[] {
  return outerFunctionBody(code).body.flatMap((statement) => {
    if (!t.isVariableDeclaration(statement)) return [];
    return statement.declarations.flatMap((declaration) =>
      t.isIdentifier(declaration.id) ? [declaration.id.name] : [],
    );
  });
}

type SelectedArm = "truthy" | "falsy";

function selectedFunctionBlock(arm: SelectedArm, sentinel: number): string {
  const declaration = `function _0xf() { return ${sentinel}; }`;
  return arm === "truthy"
    ? `if (true) { ${declaration} }`
    : `if (false) { globalThis.dead = ${sentinel}; } else { ${declaration} }`;
}

const resolutionLinkedBindings = [
  {
    id: "BR1",
    relationship: "same-function FunctionExpression self-name",
    cliRepresentative: true,
    source(arm: SelectedArm, sentinel: number): string {
      return `var invoke = function _0xf() { ${selectedFunctionBlock(arm, sentinel)} return _0xf(); }; globalThis.answer = invoke();`;
    },
  },
  {
    id: "BR2",
    relationship: "ancestor var without initializer through FunctionDeclaration",
    cliRepresentative: true,
    source(arm: SelectedArm, sentinel: number): string {
      return `function outer() { var _0xf; function inner() { ${selectedFunctionBlock(arm, sentinel)} return _0xf(); } return inner(); } globalThis.answer = outer();`;
    },
  },
  {
    id: "BR3",
    relationship: "ancestor let without initializer through FunctionExpression",
    cliRepresentative: false,
    source(arm: SelectedArm, sentinel: number): string {
      return `function outer() { let _0xf; var inner = function () { ${selectedFunctionBlock(arm, sentinel)} return _0xf(); }; return inner(); } globalThis.answer = outer();`;
    },
  },
  {
    id: "BR4",
    relationship: "ancestor class through ArrowFunctionExpression",
    cliRepresentative: true,
    source(arm: SelectedArm, sentinel: number): string {
      return `function outer() { class _0xf {} var inner = () => { ${selectedFunctionBlock(arm, sentinel)} return _0xf(); }; return inner(); } globalThis.answer = outer();`;
    },
  },
  {
    id: "BR5",
    relationship: "ancestor parameter through ObjectMethod",
    cliRepresentative: true,
    source(arm: SelectedArm, sentinel: number): string {
      return `function outer(_0xf) { var holder = { method() { ${selectedFunctionBlock(arm, sentinel)} return _0xf(); } }; return holder.method(); } globalThis.answer = outer(0);`;
    },
  },
  {
    id: "BR6",
    relationship: "ancestor hoisted sibling through FunctionDeclaration",
    cliRepresentative: false,
    source(arm: SelectedArm, sentinel: number): string {
      return `function outer() { function _0xf() { return 0; } function inner() { ${selectedFunctionBlock(arm, sentinel)} return _0xf(); } return inner(); } globalThis.answer = outer();`;
    },
  },
  {
    id: "BR7",
    relationship: "inner FunctionDeclaration own name",
    cliRepresentative: true,
    source(arm: SelectedArm, sentinel: number): string {
      return `function outer() { function _0xf(reentered) { if (reentered) return -1; ${selectedFunctionBlock(arm, sentinel)} return _0xf(1); } return _0xf(0); } globalThis.answer = outer();`;
    },
  },
  {
    id: "BR8",
    relationship: "outer FunctionExpression name through FunctionExpression",
    cliRepresentative: true,
    source(arm: SelectedArm, sentinel: number): string {
      return `var invoke = function _0xf(reentered) { if (reentered) return -1; var inner = function () { ${selectedFunctionBlock(arm, sentinel)} return _0xf(1); }; return inner(); }; globalThis.answer = invoke(0);`;
    },
  },
  {
    id: "BR9",
    relationship: "two ancestor functions through FunctionDeclaration and ObjectMethod",
    cliRepresentative: false,
    source(arm: SelectedArm, sentinel: number): string {
      return `function outer() { var _0xf; function middle() { var holder = { method() { ${selectedFunctionBlock(arm, sentinel)} return _0xf(); } }; return holder.method(); } return middle(); } globalThis.answer = outer();`;
    },
  },
] as const;

const resolutionLinkedCases = resolutionLinkedBindings.flatMap((binding, bindingIndex) =>
  (["truthy", "falsy"] as const).map((arm, armIndex) => {
    const sentinel = 101 + bindingIndex * 2 + armIndex;
    return {
      ...binding,
      arm,
      sentinel,
      source: binding.source(arm, sentinel),
      useCli: binding.cliRepresentative && arm === "truthy",
    };
  }),
);

function lines(text: string): string[] {
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function runCli(source: string, unsafe: boolean): {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdoutLines: string[];
  stderrLines: string[];
  output: string | undefined;
} {
  const dir = mkdtempSync(join(tmpdir(), "cx-02-dead-code-scope-"));
  const input = join(dir, "input.js");
  const output = join(dir, "output.js");
  try {
    writeFileSync(input, source);
    const args = ["--import", TSX_LOADER, ENTRY];
    if (unsafe) args.push("--unsafe");
    args.push(input, output);
    const result = spawnSync(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env },
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      status: result.status,
      signal: result.signal,
      stdoutLines: lines(result.stdout),
      stderrLines: lines(result.stderr),
      output: existsSync(output) ? readFileSync(output, "utf8") : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type FingerprintState = "inactive" | "active";

type ClassOracleTemplate = {
  id: string;
  classification: "qualifying" | "boundedness" | "guard-only";
  source: string;
  observedGlobals: string[];
  astRenameOuterNames?: string[];
  finalSelectedFunctionCounts?: Record<FingerprintState, number>;
  finalProgramBlockFunctionCounts?: Record<FingerprintState, number>;
};

const ACTIVE_FINGERPRINT_SUFFIX =
  " var _0xp1 = 1; var _0xp2 = 2; var _0xp3 = 3; globalThis.__cx02Fingerprint = _0xp1 + _0xp2 + _0xp3;";

function withFingerprint(source: string, fingerprint: FingerprintState): string {
  return fingerprint === "active" ? `${source}${ACTIVE_FINGERPRINT_SUFFIX}` : source;
}

function selectedDeclaration(name: string, sentinel: number, arm: "truthy" | "falsy" | "dci"): string {
  const declaration = `function ${name}() { return ${sentinel}; }`;
  if (arm === "truthy") return `if (true) { ${declaration} }`;
  if (arm === "falsy") return `if (false) { globalThis.dead = ${sentinel}; } else { ${declaration} }`;
  return `if ("cx02" === "cx02") { ${declaration} } else { globalThis.dead = ${sentinel}; }`;
}

const classOracleTemplates: ClassOracleTemplate[] = [
  {
    id: "Q01",
    classification: "qualifying",
    source: `function outer() { ${selectedDeclaration("_0xf", 301, "truthy")} return _0xf(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q02",
    classification: "qualifying",
    source: `function outer() { ${selectedDeclaration("_0xf", 302, "dci")} return _0xf(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q03",
    classification: "qualifying",
    source: `var invoke = function _0xf() { ${selectedDeclaration("_0xf", 303, "truthy")} return _0xf(); }; globalThis.answer = invoke();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q04",
    classification: "qualifying",
    source: `function outer() { var _0xf; function inner() { ${selectedDeclaration("_0xf", 304, "falsy")} return _0xf(); } return inner(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q05",
    classification: "qualifying",
    source: `function outer() { let _0xf; var inner = function () { ${selectedDeclaration("_0xf", 305, "dci")} return _0xf(); }; return inner(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q06",
    classification: "qualifying",
    source: `function outer() { class _0xf {} var inner = () => { ${selectedDeclaration("_0xf", 306, "truthy")} return _0xf(); }; return inner(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q07",
    classification: "qualifying",
    source: `function outer(_0xf) { var holder = { method() { ${selectedDeclaration("_0xf", 307, "falsy")} return _0xf(); } }; return holder.method(); } globalThis.answer = outer(0);`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q08",
    classification: "qualifying",
    source: `function outer() { function _0xf() { return 0; } function inner() { ${selectedDeclaration("_0xf", 308, "dci")} return _0xf(); } return inner(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q09",
    classification: "qualifying",
    source: `function outer() { function _0xf(reentered) { if (reentered) return -1; ${selectedDeclaration("_0xf", 309, "truthy")} return _0xf(1); } return _0xf(0); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q10",
    classification: "qualifying",
    source: `var invoke = function _0xf(reentered) { if (reentered) return -1; var inner = function () { ${selectedDeclaration("_0xf", 310, "falsy")} return _0xf(1); }; return inner(); }; globalThis.answer = invoke(0);`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q11",
    classification: "qualifying",
    source: `function outer() { var _0xf; function middle() { var holder = { method() { ${selectedDeclaration("_0xf", 311, "dci")} return _0xf(); } }; return holder.method(); } return middle(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q12",
    classification: "qualifying",
    source: `function outer() { var _0xf; var first = () => { var holder = { method() { var inner = function () { ${selectedDeclaration("_0xf", 312, "truthy")} return _0xf(); }; return inner(); } }; return holder.method(); }; return first(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q13",
    classification: "qualifying",
    source: `${selectedDeclaration("_0xf", 313, "falsy")} globalThis.answer = _0xf();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q14",
    classification: "qualifying",
    source: `function outer() { var _0xf = 0; function inner() { var _0xf; ${selectedDeclaration("_0xf", 314, "truthy")} return _0xf(); } return inner(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q15",
    classification: "qualifying",
    source: `function outer() { let _0xf = 0; var middle = () => { var inner = () => { var _0xf; ${selectedDeclaration("_0xf", 315, "falsy")} return _0xf(); }; return inner(); }; return middle(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q16",
    classification: "qualifying",
    source: `function outer() { const _0xf = 0; var first = { method() { var second = { method() { var third = { method() { var _0xf; ${selectedDeclaration("_0xf", 316, "dci")} return _0xf(); } }; return third.method(); } }; return second.method(); } }; return first.method(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "Q17",
    classification: "qualifying",
    source: `function outer() { var a; ${selectedDeclaration("a", 300, "truthy")} var _0xf; ${selectedDeclaration("_0xf", 17, "truthy")} return a() + _0xf(); } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "C01",
    classification: "boundedness",
    source: `function outer() { "use strict"; ${selectedDeclaration("_0xf", 401, "truthy")} return typeof _0xf; } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
  },
  {
    id: "C02",
    classification: "boundedness",
    source: "function outer() { if (true) { async function _0xf() { return 402; } } return typeof _0xf; } globalThis.answer = outer();",
    observedGlobals: ["answer"],
    finalSelectedFunctionCounts: { inactive: 1, active: 0 },
  },
  {
    id: "C03",
    classification: "boundedness",
    source: "function outer() { if (true) { function* _0xf() { yield 403; } } return typeof _0xf; } globalThis.answer = outer();",
    observedGlobals: ["answer"],
    finalSelectedFunctionCounts: { inactive: 1, active: 0 },
  },
  {
    id: "C04",
    classification: "boundedness",
    source: "function outer() { function _0xf() { return 404; } return 4; } globalThis.answer = outer();",
    observedGlobals: ["answer"],
  },
  {
    id: "C05",
    classification: "boundedness",
    source: "function outer(a) { if (true) { function a() { return 405; } } return typeof a; } globalThis.answer = outer(1);",
    observedGlobals: ["answer"],
  },
  {
    id: "C06",
    classification: "boundedness",
    source: "function outer() { let a; if (true) { function a() { return 406; } } return typeof a; } globalThis.answer = outer();",
    observedGlobals: ["answer"],
  },
  {
    id: "C07",
    classification: "boundedness",
    source: "function outer() { const a = 7; if (true) { function a() { return 407; } } return a; } globalThis.answer = outer();",
    observedGlobals: ["answer"],
  },
  {
    id: "C08",
    classification: "boundedness",
    source: "function outer() { var a = 8; function inner(a) { if (true) { function a() { return 408; } } return 2; } return a + inner(2); } globalThis.answer = outer();",
    observedGlobals: ["answer"],
  },
  {
    id: "C09",
    classification: "boundedness",
    source: "function outer() { var descriptiveBinding; if (true) { function descriptiveBinding() { return 409; } } return descriptiveBinding(); } globalThis.answer = outer();",
    observedGlobals: ["answer"],
  },
  {
    id: "C10",
    classification: "boundedness",
    source: `function outer() { var _0xf; var _0xa = 5; ${selectedDeclaration("_0xf", 410, "truthy")} return _0xa; } globalThis.answer = outer();`,
    observedGlobals: ["answer"],
    astRenameOuterNames: ["_0xf", "other"],
  },
  {
    id: "C11",
    classification: "boundedness",
    source: "export {}; if (true) { function _0xf() { return 411; } } globalThis.answer = 'module';",
    observedGlobals: ["answer"],
    finalProgramBlockFunctionCounts: { inactive: 1, active: 0 },
  },
  {
    id: "G01",
    classification: "guard-only",
    source: "function outer() { var _0xf; { function _0xf() { return 501; } } return _0xf(); } globalThis.answer = outer();",
    observedGlobals: ["answer"],
  },
  {
    id: "G02",
    classification: "guard-only",
    source: "function outer() { var _0xf; switch (1) { case 1: function _0xf() { return 502; } } return _0xf(); } globalThis.answer = outer();",
    observedGlobals: ["answer"],
  },
];

const classOracleRows = classOracleTemplates.flatMap((template) =>
  (["inactive", "active"] as const).map((fingerprint) => ({ ...template, fingerprint })),
);

const safeASTPasses = filterSafePasses(allASTPasses);

function productionPrefixExecutions(
  source: string,
  observedGlobals: string[],
): { safe: Execution[]; all: Execution[]; warnings: string[] } {
  const executePrefixes = (passes: typeof allASTPasses): { executions: Execution[]; warnings: string[] } => {
    const executions: Execution[] = [];
    const warnings: string[] = [];
    for (let length = 1; length <= passes.length; length += 1) {
      const result = runPipelineWithReport(source, passes.slice(0, length), [formatPass]);
      executions.push(executeFresh(result.code, observedGlobals));
      warnings.push(...result.warnings);
    }
    return { executions, warnings };
  };
  const safe = executePrefixes(safeASTPasses);
  const all = executePrefixes(allASTPasses);
  return { safe: safe.executions, all: all.executions, warnings: [...safe.warnings, ...all.warnings] };
}

const classOracleCliCases = [
  { id: "S1-active", fingerprint: "active" as const, source: classOracleTemplates[0].source, observedGlobals: ["answer"] },
  { id: "DCI-active", fingerprint: "active" as const, source: classOracleTemplates[1].source, observedGlobals: ["answer"] },
  { id: "BR2-active", fingerprint: "active" as const, source: classOracleTemplates[3].source, observedGlobals: ["answer"] },
  { id: "BR2-inactive", fingerprint: "inactive" as const, source: classOracleTemplates[3].source, observedGlobals: ["answer"] },
].flatMap((testCase) => [
  { ...testCase, mode: "default", unsafe: false },
  { ...testCase, mode: "--unsafe", unsafe: true },
]);

type ActivationOracleTemplate = {
  id: string;
  classification: "semantic" | "constant" | "boundedness";
  directConsumer: "semantic" | "constant" | "constant-after-fold" | "anti-debug";
  source: string;
  observedGlobals: string[];
  expectedDirectVariableNames?: string[];
  expectedDirectParameterNames?: string[];
  expectedUnrelatedAssignmentType?: string;
  warningBoundary?: "labelled" | "if-clause";
};

const activationOracleTemplates: ActivationOracleTemplate[] = [
  {
    id: "SA01",
    classification: "semantic",
    directConsumer: "semantic",
    source: 'function outer(){var _0xf=/f/;var _0xg=/g/;function inner(){if(true){function _0xf(){return 601;}}return _0xf();}globalThis.unrelated=_0xg.test("g");return inner();}globalThis.answer=outer();',
    observedGlobals: ["answer", "unrelated"],
    expectedDirectVariableNames: ["_0xf", "pattern"],
  },
  {
    id: "SA02",
    classification: "semantic",
    directConsumer: "semantic",
    source: 'var invoke=function(){var _0xf=[];_0xf.push(1);var inner=function(){if(false){globalThis.dead=602;}else{function _0xf(){return 602;}}return _0xf();};return inner()+_0xf.length;};globalThis.answer=invoke();',
    observedGlobals: ["answer"],
  },
  {
    id: "SA03",
    classification: "semantic",
    directConsumer: "semantic",
    source: 'function outer(){var n=0;for(var _0xf=0;_0xf<2;_0xf++){n++;}var first=()=>{var second=()=>{if("cx02"==="cx02"){function _0xf(){return 603;}}else{globalThis.dead=603;}return _0xf();};return second();};return first()+n;}globalThis.answer=outer();',
    observedGlobals: ["answer"],
  },
  {
    id: "SA04",
    classification: "semantic",
    directConsumer: "semantic",
    source: 'function outer(_0xf,callback){if(_0xf){return 0;}var holder={method(){if(true){function _0xf(){return 604;}}return _0xf();}};return holder.method();}globalThis.answer=outer(null,1);',
    observedGlobals: ["answer"],
  },
  {
    id: "SA05",
    classification: "semantic",
    directConsumer: "semantic",
    source: 'var a=[1,2];var _0xf=a.length;if(false){globalThis.dead=605;}else{function _0xf(){return 605;}}globalThis.answer=_0xf();',
    observedGlobals: ["answer"],
    warningBoundary: "labelled",
  },
  {
    id: "SA06",
    classification: "semantic",
    directConsumer: "semantic",
    source: 'function outer(){var _0xf=1;_0xf=_0xf+1;_0xf=_0xf*2;function middle(){var holder={method(){if("cx02"==="cx02"){function _0xf(){return 606;}}else{globalThis.dead=606;}return _0xf();}};return holder.method();}return middle()+_0xf;}globalThis.answer=outer();',
    observedGlobals: ["answer"],
  },
  {
    id: "SA07",
    classification: "semantic",
    directConsumer: "semantic",
    source: 'function outer(){var _0xf=JSON.parse("{}");var inner=function(){if(true){function _0xf(){return 607;}}return _0xf();};return inner();}globalThis.answer=outer();',
    observedGlobals: ["answer"],
  },
  {
    id: "SA08",
    classification: "semantic",
    directConsumer: "semantic",
    source: 'var target={addEventListener:function(name,callback){globalThis.answer=callback(null);}};target.addEventListener("x",function(_0xf){var nested=()=>{if(false){globalThis.dead=608;}else{function _0xf(){return 608;}}return _0xf();};return nested();});',
    observedGlobals: ["answer"],
  },
  {
    id: "CP01",
    classification: "constant",
    directConsumer: "constant-after-fold",
    source: 'function outer(){var s="b";var f="a"+s;var unrelated=9;function inner(){if(true){function f(){return 701;}}return f();}globalThis.unrelated=unrelated;return inner();}globalThis.answer=outer();',
    observedGlobals: ["answer", "unrelated"],
    expectedUnrelatedAssignmentType: "NumericLiteral",
  },
  {
    id: "CP02",
    classification: "constant",
    directConsumer: "constant",
    source: 'var target=function(){return -1;};var alias=target;if(false){globalThis.dead=702;}else{function alias(){return 702;}}globalThis.answer=alias();',
    observedGlobals: ["answer"],
    warningBoundary: "if-clause",
  },
  {
    id: "CP03",
    classification: "constant",
    directConsumer: "constant",
    source: 'function outer(){var f=function(){return -1;};var alias=f;var inner=()=>{if("cx02"==="cx02"){function f(){return 703;}}else{globalThis.dead=703;}return alias();};return inner();}globalThis.answer=outer();',
    observedGlobals: ["answer"],
  },
  {
    id: "CP04",
    classification: "constant",
    directConsumer: "constant",
    source: 'var f=["x","y"];if(true){function f(){return 704;}}globalThis.answer=String(f[0]);',
    observedGlobals: ["answer"],
  },
  {
    id: "CP05",
    classification: "constant",
    directConsumer: "constant",
    source: 'function outer(c){var f;if(c){f=1;}else{f=2;}if(false){globalThis.dead=705;}else{function f(){return 705;}}return typeof f;}globalThis.answer=outer(true);',
    observedGlobals: ["answer"],
  },
  {
    id: "BC01",
    classification: "boundedness",
    directConsumer: "semantic",
    source: 'function outer(){"use strict";var _0xf=/re/;if(true){function _0xf(){return 801;}}return _0xf.test("re");}globalThis.answer=outer();',
    observedGlobals: ["answer"],
    expectedDirectVariableNames: ["pattern"],
  },
  {
    id: "BC02",
    classification: "boundedness",
    directConsumer: "semantic",
    source: 'function outer(_0xf,callback){if(_0xf){return 0;}if(true){function _0xf(){return 802;}}return typeof _0xf;}globalThis.answer=outer(null,1);',
    observedGlobals: ["answer"],
    expectedDirectParameterNames: ["err", "callback"],
  },
  {
    id: "BC03",
    classification: "boundedness",
    directConsumer: "constant",
    source: 'function outer(){var target=function(){return 1;};var alias=target;function inner(target){return alias();}return inner(function(){return 2;});}globalThis.answer=outer();',
    observedGlobals: ["answer"],
  },
  {
    id: "BC04",
    classification: "boundedness",
    directConsumer: "anti-debug",
    source: 'function host(){function _0xdead(){return 1;}function trap(){return [].constructor("debugger")();}trap(_0xdead);return 7;}globalThis.answer=host();',
    observedGlobals: ["answer"],
  },
];

const activationOracleRows = activationOracleTemplates.flatMap((template) =>
  (["inactive", "active"] as const).map((fingerprint) => ({ ...template, fingerprint })),
);

const activationOracleCliCases = activationOracleTemplates
  .filter(({ id }) => id === "SA01" || id === "CP01")
  .flatMap((template) =>
    (["inactive", "active"] as const).flatMap((fingerprint) =>
      ([{ mode: "default", unsafe: false }, { mode: "--unsafe", unsafe: true }] as const)
        .map((cli) => ({ ...template, fingerprint, ...cli })),
    ),
  );

function directActivationConsumer(
  template: ActivationOracleTemplate,
  source: string,
): { code: string; warnings: string[]; execution: Execution } {
  const passes = template.directConsumer === "semantic"
    ? [semanticRenamePass]
    : template.directConsumer === "constant"
      ? [constantPropagatePass]
      : template.directConsumer === "constant-after-fold"
        ? [constantFoldPass, constantPropagatePass]
        : [antiDebugPass];
  const result = runPipelineWithReport(source, passes, [formatPass]);
  return {
    code: result.code,
    warnings: result.warnings,
    execution: executeFresh(result.code, template.observedGlobals),
  };
}

function outerFunctionParameterNames(code: string): string[] {
  const outer = parse(code).program.body.find((statement) => t.isFunctionDeclaration(statement));
  if (!t.isFunctionDeclaration(outer)) return [];
  return outer.params.flatMap((parameter) => t.isIdentifier(parameter) ? [parameter.name] : []);
}

function globalAssignmentRightType(code: string, propertyName: string): string | undefined {
  let result: string | undefined;
  traverse(parse(code), {
    AssignmentExpression(path: { node: t.AssignmentExpression }) {
      if (
        t.isMemberExpression(path.node.left) &&
        t.isIdentifier(path.node.left.object, { name: "globalThis" }) &&
        t.isIdentifier(path.node.left.property, { name: propertyName })
      ) {
        result = path.node.right.type;
      }
    },
  });
  return result;
}

function namedDirectBodyFunctionDeclarationCount(code: string, name: string): number {
  return outerFunctionBody(code).body.filter(
    (statement) => t.isFunctionDeclaration(statement) && statement.id?.name === name,
  ).length;
}

function warningBoundaryResult(kind: "labelled" | "if-clause"): {
  recoveredErrors: number;
  pipelineWarning: boolean;
  cliStatus: number | null;
  cliSignal: NodeJS.Signals | null;
  cliWarning: boolean;
  cliDoneLines: number;
  cliOutputPresent: boolean;
  cleanBlockWarnings: string[];
  cleanSwitchWarnings: string[];
} {
  const warnedSource = kind === "labelled"
    ? "if(true){function sibling(){} label: function _0xf(){return 5;}}globalThis.answer=_0xf();"
    : "function outer(){if(true){function sibling(){} if(globalThis.c===undefined) function _0xf(){return 6;}}return _0xf();}globalThis.answer=outer();";
  const warned = runPipelineWithReport(warnedSource, safeASTPasses, [formatPass]);
  const cli = runCli(warnedSource, false);
  const cliWarningsAndErrors = cli.stderrLines.filter((line) => /^(WARNING|ERROR):/.test(line));
  const cleanBlock = runPipelineWithReport(
    "function outer(){if(true){function _0xf(){return 1;}}return _0xf();}globalThis.answer=outer();",
    safeASTPasses,
    [formatPass],
  );
  const cleanSwitch = runPipelineWithReport(
    "function outer(){switch(1){case 1:function _0xf(){return 1;}}return _0xf();}globalThis.answer=outer();",
    safeASTPasses,
    [formatPass],
  );
  return {
    recoveredErrors: warned.initialParse.recoveredErrors,
    pipelineWarning: warned.warnings.length > 0
      && warned.warnings.every((warning) => warning.startsWith("Parse error (recovered):")),
    cliStatus: cli.status,
    cliSignal: cli.signal,
    cliWarning: cliWarningsAndErrors.length > 0
      && cliWarningsAndErrors.every((warning) => warning.startsWith("WARNING: Parse error (recovered):")),
    cliDoneLines: cli.stdoutLines.filter((line) => line.startsWith("Done: ")).length,
    cliOutputPresent: cli.output !== undefined,
    cleanBlockWarnings: cleanBlock.warnings,
    cleanSwitchWarnings: cleanSwitch.warnings,
  };
}


type NormalizedValue = null | boolean | number | string | NormalizedValue[] | { [key: string]: NormalizedValue };
type RuntimeOutcome = {
  completion: "normal" | "throw";
  errorConstructor: string | null;
  errorMessage: string | null;
  globals: Record<string, NormalizedValue>;
};

function normalizedValue(value: unknown): NormalizedValue {
  if (value === undefined) return "<undefined>";
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "<NaN>";
    if (!Number.isFinite(value)) return value > 0 ? "<Infinity>" : "<-Infinity>";
    return Object.is(value, -0) ? "<-0>" : value;
  }
  if (typeof value === "bigint") return value.toString() + "n";
  if (typeof value === "function") return "<function:" + value.name + ">";
  if (Array.isArray(value)) return Array.from(value, normalizedValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map(
      (key) => [key, normalizedValue(Reflect.get(value as object, key))],
    ));
  }
  return "<" + typeof value + ">";
}

function executeNormalized(source: string, observed: readonly string[]): RuntimeOutcome {
  const context = vm.createContext(Object.create(null));
  const globals = (): Record<string, NormalizedValue> =>
    Object.fromEntries(observed.map((name) => [name, normalizedValue(Reflect.get(context, name))]));
  try {
    vm.runInContext(source, context, { timeout: 2_000 });
    return { completion: "normal", errorConstructor: null, errorMessage: null, globals: globals() };
  } catch (error: unknown) {
    const errorConstructor =
      typeof error === "object" && error !== null && "constructor" in error
        ? String((error as { constructor?: { name?: unknown } }).constructor?.name ?? typeof error)
        : typeof error;
    return { completion: "throw", errorConstructor, errorMessage: typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error), globals: globals() };
  }
}

function safeAndAll(
  source: string,
  observed: readonly string[],
): Array<{ layer: "safe" | "all"; outcome: RuntimeOutcome; warnings: string[]; code: string }> {
  return [
    { layer: "safe" as const, passes: safeASTPasses },
    { layer: "all" as const, passes: allASTPasses },
  ].map(({ layer, passes }) => {
    const result = runPipelineWithReport(source, passes, [formatPass]);
    return { layer, outcome: executeNormalized(result.code, observed), warnings: result.warnings, code: result.code };
  });
}

type DeclarationInstantiationOutcome = {
  completion: "normal" | "throw";
  errorName: string | null;
  globals: Record<string, { present: boolean; value?: unknown }>;
};

function declarationInstantiationValue(value: unknown): { present: boolean; value: unknown } {
  return { present: true, value: value === undefined ? "<undefined>" : value };
}

function executeDeclarationInstantiation(
  source: string,
  observed: readonly string[],
): DeclarationInstantiationOutcome {
  const context = vm.createContext(Object.create(null));
  const globals = (): Record<string, { present: boolean; value?: unknown }> => Object.fromEntries(
    observed.map((name) => {
      const isPresent = Object.prototype.hasOwnProperty.call(context, name);
      return [name, isPresent ? declarationInstantiationValue(Reflect.get(context, name)) : { present: false }];
    }),
  );
  try {
    vm.runInContext(source, context, { timeout: 2_000 });
    return { completion: "normal", errorName: null, globals: globals() };
  } catch (error: unknown) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name: unknown }).name)
        : typeof error;
    return { completion: "throw", errorName, globals: globals() };
  }
}

function declarationTypeCount(source: string, declarationType: string): number {
  let count = 0;
  traverse(parse(source), {
    enter(path: { node: t.Node }) {
      if (path.node.type === declarationType) count += 1;
    },
  });
  return count;
}

const declarationInstantiationCompositionCases = [
  {
    id: "W-DI-01",
    source: "if(false) function f(){}; globalThis.answer=f;",
    observed: ["answer"],
    expected: {
      completion: "normal",
      errorName: null,
      globals: { answer: declarationInstantiationValue(undefined) },
    } as DeclarationInstantiationOutcome,
    declarationType: "FunctionDeclaration",
    finalDeclarationCount: 1,
  },
  {
    id: "W-DI-02",
    source: "function probe(){globalThis.answer=hidden;return;var hidden;}probe();",
    observed: ["answer"],
    expected: {
      completion: "normal",
      errorName: null,
      globals: { answer: declarationInstantiationValue(undefined) },
    } as DeclarationInstantiationOutcome,
    declarationType: "VariableDeclarator",
    finalDeclarationCount: 1,
  },
  {
    id: "branch-var",
    source: "function probe(){if(false){var branchCell;}globalThis.answer=branchCell;}probe();",
    observed: ["answer"],
    expected: {
      completion: "normal",
      errorName: null,
      globals: { answer: declarationInstantiationValue(undefined) },
    } as DeclarationInstantiationOutcome,
    declarationType: "VariableDeclarator",
    finalDeclarationCount: 1,
  },
  {
    id: "W-DI-TDZ-LET",
    source: "function probe(){globalThis.answer=typeof hidden;return;let hidden;}probe();",
    observed: ["answer"],
    expected: {
      completion: "throw",
      errorName: "ReferenceError",
      globals: { answer: { present: false } },
    } as DeclarationInstantiationOutcome,
    declarationType: "VariableDeclarator",
    finalDeclarationCount: 1,
  },
  {
    id: "W-DI-TDZ-CLASS",
    source: "function probe(){globalThis.answer=typeof Hidden;return;class Hidden{}}probe();",
    observed: ["answer"],
    expected: {
      completion: "throw",
      errorName: "ReferenceError",
      globals: { answer: { present: false } },
    } as DeclarationInstantiationOutcome,
    declarationType: "ClassDeclaration",
    finalDeclarationCount: 1,
  },
  {
    id: "internal-only control",
    source: "function probe(){if(false){var local;local=1;globalThis.dead=local;}globalThis.answer=42;}probe();",
    observed: ["answer", "dead"],
    expected: {
      completion: "normal",
      errorName: null,
      globals: { answer: declarationInstantiationValue(42), dead: { present: false } },
    } as DeclarationInstantiationOutcome,
    declarationType: "VariableDeclarator",
    finalDeclarationCount: 0,
  },
] as const;

const coveringAxes = {
  declaration: ["class", "strict_ordinary_function", "async_function", "generator_function", "async_generator_function", "sloppy_ordinary_annex_b", "used_let_base_wrong", "used_const_base_wrong"],
  site: ["in_block_before", "in_block_after", "after_block"],
  placement: ["if_true", "if_false_alternate", "dead_code_injection", "switch_case", "bare_block", "non_constant_if"],
  trigger: ["array_method", "regex", "arithmetic_majority", "length", "json_parse", "error_parameter", "event_parameter"],
  owner: ["Program", "function", "nested_function"],
  fingerprint: ["inactive", "active"],
  passList: ["safe", "all"],
} as const;
type CoveringAxis = keyof typeof coveringAxes;
type CoveringTuple = Record<CoveringAxis, string>;
const axisNames = Object.keys(coveringAxes).sort() as CoveringAxis[];
function tupleId(row: CoveringTuple): string {
  return axisNames.map((axis) => axis + "=" + row[axis]).join("|");
}
function obligations(row: CoveringTuple): string[] {
  const values = axisNames.map((axis) => axis + "=" + row[axis]);
  return values.concat(values.flatMap((left, i) => values.slice(i + 1).map((right) => left + "&" + right)));
}
function coveringInventory(): { valid: CoveringTuple[]; rejected: CoveringTuple[] } {
  let rows: Partial<CoveringTuple>[] = [{}];
  for (const axis of axisNames) {
    rows = rows.flatMap((row) => [...coveringAxes[axis]].sort().map((value) => ({ ...row, [axis]: value })));
  }
  const valid: CoveringTuple[] = [];
  const rejected: CoveringTuple[] = [];
  for (const partial of rows) {
    const row = partial as CoveringTuple;
    (row.owner === "Program" && ["error_parameter", "event_parameter"].includes(row.trigger) ? rejected : valid).push(row);
  }
  return { valid, rejected };
}
function selectCoveringRows(): { rows: CoveringTuple[]; teeth: Record<string, string>; universe: string[]; removed: string[] } {
  const { valid } = coveringInventory();
  const universe = new Set(valid.flatMap(obligations));
  const uncovered = new Set(universe);
  const selected: CoveringTuple[] = [];
  // Maximum uncovered coverage; ties follow the stable lexical tuple inventory.
  while (uncovered.size > 0) {
    let best: CoveringTuple | undefined;
    let score = 0;
    for (const row of valid) {
      const count = obligations(row).filter((item) => uncovered.has(item)).length;
      if (count > score) { best = row; score = count; }
    }
    if (!best) throw new Error("Uncovered obligation has no valid tuple");
    selected.push(best);
    obligations(best).forEach((item) => uncovered.delete(item));
  }
  selected.sort((a, b) => tupleId(a) < tupleId(b) ? -1 : tupleId(a) > tupleId(b) ? 1 : 0);
  const counts = new Map<string, number>();
  selected.forEach((row) => obligations(row).forEach((item) => counts.set(item, (counts.get(item) ?? 0) + 1)));
  const removed: string[] = [];
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    const covers = obligations(selected[i]);
    if (covers.every((item) => (counts.get(item) ?? 0) > 1)) {
      removed.push(tupleId(selected[i]));
      covers.forEach((item) => counts.set(item, (counts.get(item) ?? 0) - 1));
      selected.splice(i, 1);
    }
  }
  const teeth = Object.fromEntries(selected.map((row) => [tupleId(row), obligations(row).find((item) => counts.get(item) === 1) ?? ""]));
  return { rows: selected, teeth, universe: [...universe].sort(), removed };
}
const covering = selectCoveringRows();
const triggerSpecs: Record<string, { destination: string; init: string; use: string }> = {
  array_method: { destination: "arr", init: "var _0xv=[]; _0xv.push(1);", use: "_0xv.length" },
  regex: { destination: "pattern", init: "var _0xv=/a/;", use: "_0xv.test('a')" },
  arithmetic_majority: { destination: "num", init: "var _0xv=2; _0xv=_0xv*3;", use: "(_0xv+1)+(_0xv*2)" },
  length: { destination: "len", init: "var _0xv=String(12345).length;", use: "_0xv" },
  json_parse: { destination: "data", init: "var _0xv=JSON.parse('[1,2]');", use: "_0xv.length" },
  error_parameter: { destination: "err", init: "if(_0xv) return 'handled';", use: "_0xv===null" },
  event_parameter: { destination: "event", init: "", use: "_0xv.type" },
};
function coveringProgram(row: CoveringTuple): string {
  const spec = triggerSpecs[row.trigger];
  const n = spec.destination;
  const declarations: Record<string, string> = {
    class: "class " + n + " {}",
    strict_ordinary_function: "function " + n + "() {}",
    async_function: "async function " + n + "() {}",
    generator_function: "function* " + n + "() {}",
    async_generator_function: "async function* " + n + "() {}",
    sloppy_ordinary_annex_b: "function " + n + "() {}",
    used_let_base_wrong: "let " + n + "=globalThis.seed||7;globalThis.local=" + n + ";",
    used_const_base_wrong: "const " + n + "=globalThis.seed||7;globalThis.local=" + n + ";",
  };
  const read = "globalThis.answer=" + spec.use + ";";
  const body = (row.site === "in_block_before" ? read : "") + declarations[row.declaration] +
    (row.site === "in_block_after" ? read : "");
  const placements: Record<string, string> = {
    if_true: "if(true){" + body + "}",
    if_false_alternate: "if(false){globalThis.dead=1;}else{" + body + "}",
    dead_code_injection: "if('a'==='a'){" + body + "}else{globalThis.dead=1;}",
    switch_case: "switch(1){case 1:" + body + "break;}",
    bare_block: "{" + body + "}",
    non_constant_if: "if(globalThis.flag===undefined){" + body + "}",
  };
  const core = spec.init + placements[row.placement] + (row.site === "after_block" ? read : "");
  let source: string;
  if (row.trigger === "error_parameter") {
    source = "function own(_0xv,callback){" + core + "}own(null,function(){});";
  } else if (row.trigger === "event_parameter") {
    source = "var target={addEventListener:function(type,handler){return handler({type:type});}};target.addEventListener('tick',function(_0xv){" + core + "});";
  } else source = row.owner === "Program" ? core : "function own(){" + core + "}own();";
  if (row.owner === "nested_function") source = "function outer(){" + source + "}outer();";
  if (row.declaration === "strict_ordinary_function") source = '"use strict";' + source;
  return withFingerprint(source, row.fingerprint as FingerprintState);
}
// Structural types keep the oracle on the installed Babel objects without requiring external declarations.
type SitePath = { node: t.Node; scope: { hasBinding(name: string): boolean }; parentPath: SitePath | null };
type ExactBinding = { path: SitePath; referencePaths: SitePath[]; constantViolations: SitePath[]; identifier: { name: string } };
function exactSites(binding: ExactBinding): SitePath[] {
  return [...new Set([binding.path, ...binding.referencePaths, ...binding.constantViolations])];
}
function getProbeBinding(ast: t.File): ExactBinding {
  let found: ExactBinding | undefined;
  traverse(ast, { Scope(path: { scope: { getOwnBinding(name: string): unknown } }) {
    const binding = path.scope.getOwnBinding("_0xv") as ExactBinding | undefined;
    if (binding) found = binding;
  } });
  if (!found) throw new Error("Fixture has no exact _0xv Binding");
  return found;
}
const baseCoveringOutcomes: Array<{ id: string; outcome: RuntimeOutcome }> = [
  {"id": "declaration=async_function|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=after_block|trigger=arithmetic_majority", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 19, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_function|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=after_block|trigger=length", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 5, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_function|fingerprint=active|owner=Program|passList=all|placement=non_constant_if|site=after_block|trigger=json_parse", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 2, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_function|fingerprint=active|owner=function|passList=all|placement=dead_code_injection|site=after_block|trigger=event_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": "tick", "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_function|fingerprint=active|owner=function|passList=all|placement=switch_case|site=after_block|trigger=error_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_function|fingerprint=active|owner=nested_function|passList=safe|placement=if_true|site=in_block_after|trigger=array_method", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 1, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_function|fingerprint=inactive|owner=function|passList=all|placement=if_false_alternate|site=in_block_before|trigger=regex", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=async_generator_function|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=after_block|trigger=json_parse", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 2, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_generator_function|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=after_block|trigger=regex", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_generator_function|fingerprint=active|owner=Program|passList=all|placement=if_false_alternate|site=after_block|trigger=length", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 5, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_generator_function|fingerprint=active|owner=Program|passList=all|placement=if_true|site=after_block|trigger=arithmetic_majority", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 19, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_generator_function|fingerprint=active|owner=function|passList=all|placement=non_constant_if|site=after_block|trigger=error_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_generator_function|fingerprint=active|owner=nested_function|passList=safe|placement=switch_case|site=in_block_before|trigger=event_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": "tick", "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=async_generator_function|fingerprint=inactive|owner=function|passList=safe|placement=dead_code_injection|site=in_block_after|trigger=array_method", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 1, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=class|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=after_block|trigger=arithmetic_majority", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 19, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=class|fingerprint=active|owner=Program|passList=all|placement=dead_code_injection|site=after_block|trigger=array_method", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 1, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=class|fingerprint=active|owner=Program|passList=all|placement=dead_code_injection|site=after_block|trigger=regex", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=class|fingerprint=active|owner=Program|passList=all|placement=if_true|site=after_block|trigger=length", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 5, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=class|fingerprint=active|owner=function|passList=all|placement=non_constant_if|site=after_block|trigger=event_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": "tick", "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=class|fingerprint=active|owner=nested_function|passList=safe|placement=if_false_alternate|site=in_block_before|trigger=error_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=class|fingerprint=inactive|owner=function|passList=all|placement=switch_case|site=in_block_after|trigger=json_parse", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 0, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=generator_function|fingerprint=active|owner=Program|passList=all|placement=dead_code_injection|site=after_block|trigger=arithmetic_majority", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 19, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=generator_function|fingerprint=active|owner=Program|passList=all|placement=if_false_alternate|site=after_block|trigger=array_method", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 1, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=generator_function|fingerprint=active|owner=function|passList=all|placement=bare_block|site=after_block|trigger=event_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": "tick", "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=generator_function|fingerprint=active|owner=function|passList=all|placement=switch_case|site=after_block|trigger=error_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=generator_function|fingerprint=active|owner=function|passList=safe|placement=bare_block|site=in_block_after|trigger=length", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 5, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=generator_function|fingerprint=active|owner=nested_function|passList=all|placement=non_constant_if|site=after_block|trigger=regex", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=generator_function|fingerprint=inactive|owner=Program|passList=all|placement=if_true|site=in_block_before|trigger=json_parse", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 2, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=sloppy_ordinary_annex_b|fingerprint=active|owner=Program|passList=all|placement=dead_code_injection|site=in_block_before|trigger=length", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 5, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=sloppy_ordinary_annex_b|fingerprint=active|owner=Program|passList=all|placement=if_true|site=after_block|trigger=regex", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=sloppy_ordinary_annex_b|fingerprint=active|owner=Program|passList=all|placement=switch_case|site=after_block|trigger=array_method", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 0, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=sloppy_ordinary_annex_b|fingerprint=active|owner=function|passList=all|placement=if_false_alternate|site=after_block|trigger=error_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=sloppy_ordinary_annex_b|fingerprint=active|owner=function|passList=all|placement=non_constant_if|site=in_block_after|trigger=event_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": "tick", "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=sloppy_ordinary_annex_b|fingerprint=active|owner=nested_function|passList=all|placement=bare_block|site=after_block|trigger=json_parse", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 2, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=sloppy_ordinary_annex_b|fingerprint=inactive|owner=nested_function|passList=safe|placement=non_constant_if|site=in_block_before|trigger=arithmetic_majority", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 19, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=strict_ordinary_function|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=after_block|trigger=regex", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=strict_ordinary_function|fingerprint=active|owner=Program|passList=all|placement=dead_code_injection|site=after_block|trigger=json_parse", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 2, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=strict_ordinary_function|fingerprint=active|owner=Program|passList=all|placement=non_constant_if|site=in_block_before|trigger=array_method", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 0, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=strict_ordinary_function|fingerprint=active|owner=function|passList=all|placement=bare_block|site=after_block|trigger=error_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=strict_ordinary_function|fingerprint=active|owner=function|passList=all|placement=if_true|site=after_block|trigger=event_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": "tick", "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=strict_ordinary_function|fingerprint=active|owner=function|passList=safe|placement=if_false_alternate|site=in_block_after|trigger=arithmetic_majority", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 19, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=strict_ordinary_function|fingerprint=inactive|owner=nested_function|passList=all|placement=switch_case|site=after_block|trigger=length", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 5, "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=used_const_base_wrong|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=after_block|trigger=array_method", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 1, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_const_base_wrong|fingerprint=active|owner=Program|passList=all|placement=dead_code_injection|site=after_block|trigger=arithmetic_majority", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 19, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_const_base_wrong|fingerprint=active|owner=Program|passList=all|placement=if_false_alternate|site=after_block|trigger=json_parse", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 2, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_const_base_wrong|fingerprint=active|owner=Program|passList=all|placement=non_constant_if|site=after_block|trigger=length", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 5, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_const_base_wrong|fingerprint=active|owner=Program|passList=safe|placement=switch_case|site=in_block_after|trigger=regex", "outcome": {"completion": "throw", "errorConstructor": "TypeError", "errorMessage": "pattern.test is not a function", "globals": {"answer": "<undefined>", "local": 7, "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=used_const_base_wrong|fingerprint=active|owner=function|passList=all|placement=if_true|site=after_block|trigger=error_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_const_base_wrong|fingerprint=inactive|owner=nested_function|passList=all|placement=bare_block|site=in_block_before|trigger=event_parameter", "outcome": {"completion": "throw", "errorConstructor": "ReferenceError", "errorMessage": "Cannot access 'event' before initialization", "globals": {"answer": "<undefined>", "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=used_let_base_wrong|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=after_block|trigger=regex", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": true, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_let_base_wrong|fingerprint=active|owner=Program|passList=all|placement=bare_block|site=in_block_before|trigger=array_method", "outcome": {"completion": "throw", "errorConstructor": "ReferenceError", "errorMessage": "Cannot access 'arr' before initialization", "globals": {"answer": "<undefined>", "local": "<undefined>", "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
  {"id": "declaration=used_let_base_wrong|fingerprint=active|owner=Program|passList=all|placement=non_constant_if|site=after_block|trigger=length", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 5, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_let_base_wrong|fingerprint=active|owner=Program|passList=all|placement=switch_case|site=after_block|trigger=arithmetic_majority", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 19, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_let_base_wrong|fingerprint=active|owner=function|passList=all|placement=if_false_alternate|site=after_block|trigger=event_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": "tick", "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_let_base_wrong|fingerprint=active|owner=function|passList=safe|placement=if_true|site=after_block|trigger=json_parse", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": 2, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": 6}}},
  {"id": "declaration=used_let_base_wrong|fingerprint=inactive|owner=nested_function|passList=all|placement=dead_code_injection|site=in_block_after|trigger=error_parameter", "outcome": {"completion": "normal", "errorConstructor": null, "errorMessage": null, "globals": {"answer": false, "local": 7, "dead": "<undefined>", "__cx02Fingerprint": "<undefined>"}}},
];
const observedCoveringGlobals = ["answer", "local", "dead", "__cx02Fingerprint"] as const;

function cloneRepresentative(shape: "proxy-clone" | "direct-control"): string {
  const proxy = "var _0xobj={'abc':function(_0xa,_0xb){return _0xa(_0xb);}};";
  const trigger = "function(_0xq){var _0xf=[];_0xf.push(7);if(true){class arr{}return _0xf.length;}}";
  const linked = "function(_0xq){var _0xf=_0xq+1;function inner(){if(true){function _0xf(){return 5;}}return _0xf();}return [inner(),typeof _0xf];}";
  const call = (body: string): string => shape === "proxy-clone" ? "_0xobj['abc'](" + body + ",10)" : "(" + body + ")(10)";
  return proxy + "globalThis.r1=JSON.stringify(" + call(trigger) + ");globalThis.answer=JSON.stringify(" + call(linked) + ");" + ACTIVE_FINGERPRINT_SUFFIX;
}

function declarationCounts(code: string, names: readonly string[]): Record<string, number> {
  const counts = Object.fromEntries(names.map((name) => [name, 0]));
  traverse(parse(code), {
    VariableDeclarator(path: { node: t.VariableDeclarator }) {
      if (t.isIdentifier(path.node.id) && path.node.id.name in counts) counts[path.node.id.name] += 1;
    },
    FunctionDeclaration(path: { node: t.FunctionDeclaration }) {
      if (path.node.id && path.node.id.name in counts) counts[path.node.id.name] += 1;
    },
  });
  return counts;
}
function positionlessBindingShape(source: string): { distinct: number; starts: Array<number | null> } {
  const bindings = new Set<{ identifier: { start?: number | null } }>();
  traverse(controlFlowObjectPass.run(parse(source), source), {
    Scope(path: { scope: { getOwnBinding(name: string): unknown } }) {
      const binding = path.scope.getOwnBinding("_0xf") as { identifier: { start?: number | null } } | undefined;
      if (binding) bindings.add(binding as { identifier: { start?: number | null } });
    },
  });
  return {
    distinct: bindings.size,
    starts: Array.from(bindings, (binding) => binding.identifier.start ?? null).sort(),
  };
}
const BUNDLER_MODULES = [
  'function(module,exports,__webpack_require__){var _0xf=/re/;if(true){class pattern{}module.exports=_0xf.test("re");}}',
  'function(module,exports,__webpack_require__){var _0xf=module.seed+1;function inner(){if(true){function _0xf(){return 5;}}return _0xf();}module.exports=[inner(),typeof _0xf];}',
];
const BUNDLER_POSITIONLESS_SOURCE = '(function(modules){function __webpack_require__(id){var module={exports:{}};modules[id](module,module.exports,__webpack_require__);return module.exports;}return __webpack_require__(0);})([' + BUNDLER_MODULES.join(',') + ']);';

function bundlerPositionlessBindingShape(source: string): { distinct: number; starts: Array<number | null> } {
  const bindings = new Set<{ identifier: { start?: number | null } }>();
  traverse(bundlerUnpackPass.run(parse(source), source), {
    Scope(path: { scope: { getOwnBinding(name: string): unknown } }) {
      const binding = path.scope.getOwnBinding("_0xf") as { identifier: { start?: number | null } } | undefined;
      if (binding) bindings.add(binding);
    },
  });
  return {
    distinct: bindings.size,
    starts: Array.from(bindings, (binding) => binding.identifier.start ?? null).sort(),
  };
}

const linkageRows = [
  {
    id: "semantic SwitchCase linked source",
    passes: [semanticRenamePass],
    source: "function outer() { var _0xf = []; _0xf.push(1); switch (1) { case 1: function _0xf() { return 921; } } return _0xf(); } globalThis.answer = outer();",
  },
  {
    id: "constant-propagate SwitchCase linked source",
    passes: [constantFoldPass, constantPropagatePass],
    source: "function outer() { var s = 'b'; var f = 'a' + s; function inner() { switch (1) { case 1: function f() { return 922; } } return f(); } return inner(); } globalThis.answer = outer();",
  },
  {
    id: "constant-propagate FunctionExpression self-name alias target",
    passes: [constantPropagatePass],
    source: "var invoke = function _0xf(reentered) { if (reentered) return 31; var alias = _0xf; if (true) { function _0xf() { return 923; } } return alias(true); }; globalThis.answer = invoke(false);",
  },
] as const;

describe("CX-02 selected dead-code branch scope preservation", () => {
  it("FunctionDeclaration declaring scope composition: consequent_parameter_shadow", () => {
    const source = "if(false) function g(g){}; globalThis.answer=g;";
    const expected: DeclarationInstantiationOutcome = {
      completion: "normal",
      errorName: null,
      globals: { answer: declarationInstantiationValue(undefined) },
    };
    expect(executeDeclarationInstantiation(source, ["answer"])).toEqual(expected);
    expect(declarationTypeCount(source, "FunctionDeclaration")).toBe(1);

    const results = [filterSafePasses(allASTPasses), allASTPasses].map((passes) => {
      const result = runPipelineWithReport(source, passes, [formatPass]);
      return {
        outcome: executeDeclarationInstantiation(result.code, ["answer"]),
        declarationCount: declarationTypeCount(result.code, "FunctionDeclaration"),
      };
    });
    expect(results.map(({ outcome }) => outcome)).toEqual([expected, expected]);
    expect(results.map(({ declarationCount }) => declarationCount)).toEqual([1, 1]);
  });

  it.each(declarationInstantiationCompositionCases)(
    "production composition: $id",
    ({ source, observed, expected, declarationType, finalDeclarationCount }) => {
      expect(executeDeclarationInstantiation(source, observed)).toEqual(expected);

      for (const passes of [filterSafePasses(allASTPasses), allASTPasses]) {
        const result = runPipelineWithReport(source, passes, [formatPass]);
        expect(executeDeclarationInstantiation(result.code, observed)).toEqual(expected);
        expect(declarationTypeCount(result.code, declarationType)).toBe(finalDeclarationCount);
      }
    },
  );

  const classCases = [
    {
      name: "true consequent keeps the exact MISSED-02 class local",
      source: "if (true) { class C {} } globalThis.answer = typeof C;",
    },
    {
      name: "false alternate keeps its class local",
      source: "if (false) { globalThis.dead = true; } else { class E {} } globalThis.answer = typeof E;",
    },
  ] as const;

  it.each(classCases)("direct and default pipeline: $name", ({ source }) => {
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);
    const expected: Execution = { completion: "normal", globals: { answer: "undefined" } };

    expect({
      source: executeFresh(source, ["answer"]),
      direct: executeFresh(direct, ["answer"]),
      defaultPipeline: executeFresh(pipeline.code, ["answer"]),
      pipelineWarnings: pipeline.warnings,
    }).toEqual({
      source: expected,
      direct: expected,
      defaultPipeline: expected,
      pipelineWarnings: [],
    });
    expectDirectRetainedBlock(source, "ClassDeclaration");
    expectPipelineRetainedBlock(source, "ClassDeclaration");
  });

  it("keeps an earlier typeof read outside a lifted class TDZ", () => {
    const source = "globalThis.answer = typeof C; if (true) { class C {} }";
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);
    const expected: Execution = { completion: "normal", globals: { answer: "undefined" } };

    expect({
      source: executeFresh(source, ["answer"]),
      direct: executeFresh(direct, ["answer"]),
      defaultPipeline: executeFresh(pipeline.code, ["answer"]),
      pipelineWarnings: pipeline.warnings,
    }).toEqual({
      source: expected,
      direct: expected,
      defaultPipeline: expected,
      pipelineWarnings: [],
    });
    expectDirectRetainedBlock(source, "ClassDeclaration");
    expectPipelineRetainedBlock(source, "ClassDeclaration");
  });

  const strictFunctionCases = [
    {
      name: "true consequent",
      source: '"use strict"; if (true) { function localFn() {} } globalThis.answer = typeof localFn;',
    },
    {
      name: "false alternate",
      source: '"use strict"; if (false) { globalThis.dead = true; } else { function alternateFn() {} } globalThis.answer = typeof alternateFn;',
    },
  ] as const;

  it.each(strictFunctionCases)("keeps a strict block function local in the $name", ({ source }) => {
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);
    const expected: Execution = { completion: "normal", globals: { answer: "undefined" } };

    expect({
      source: executeFresh(source, ["answer"]),
      direct: executeFresh(direct, ["answer"]),
      defaultPipeline: executeFresh(pipeline.code, ["answer"]),
      pipelineWarnings: pipeline.warnings,
    }).toEqual({
      source: expected,
      direct: expected,
      defaultPipeline: expected,
      pipelineWarnings: [],
    });
    expectDirectRetainedBlock(source, "FunctionDeclaration");
    expectPipelineRetainedBlock(source, "FunctionDeclaration");
  });

  const standingLexicalCases = [
    {
      name: "let in a true consequent",
      source: "if (true) { let local = 3; globalThis.inside = local; } globalThis.answer = typeof local;",
      expected: { completion: "normal", globals: { inside: 3, answer: "undefined" } } as Execution,
    },
    {
      name: "const in a false alternate",
      source: "if (false) { globalThis.dead = true; } else { const local = 4; globalThis.inside = local; } globalThis.answer = typeof local;",
      expected: { completion: "normal", globals: { inside: 4, answer: "undefined" } } as Execution,
    },
  ] as const;

  it.each(standingLexicalCases)("preserves the standing $name control", ({ source, expected }) => {
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);
    expect(executeFresh(source, ["inside", "answer"])).toEqual(expected);
    expect(executeFresh(direct, ["inside", "answer"])).toEqual(expected);
    expect(executeFresh(pipeline.code, ["inside", "answer"])).toEqual(expected);
    expect(pipeline.warnings).toEqual([]);
    expect(directProgram(source).body.some((statement) => t.isBlockStatement(statement))).toBe(true);
    expect(parse(pipeline.code).program.body.some((statement) => t.isBlockStatement(statement))).toBe(true);
  });

  const nonVarDeclarationCases = [
    {
      name: "using",
      kind: "using",
      source: "if (true) { using resource = acquire(); globalThis.answer = resource; }",
      selectedBody(program: t.Program): t.Statement[] {
        return program.body;
      },
    },
    {
      name: "await using",
      kind: "await using",
      source: "async function consume() { if (true) { await using resource = acquire(); globalThis.answer = resource; } }",
      selectedBody(program: t.Program): t.Statement[] {
        const fn = program.body[0];
        expect(t.isFunctionDeclaration(fn)).toBe(true);
        return t.isFunctionDeclaration(fn) ? fn.body.body : [];
      },
    },
  ] as const;

  it.each(nonVarDeclarationCases)("structurally retains the selected block for $name", ({ source, kind, selectedBody }) => {
    // This is deliberately a pinned-parser AST oracle, not a Node disposal-semantics claim.
    const parsed = parse(source);
    const sourceBody = selectedBody(parsed.program);
    const sourceIf = sourceBody.find((statement) => t.isIfStatement(statement));
    expect(sourceIf?.type).toBe("IfStatement");
    const sourceBlock = sourceIf && t.isBlockStatement(sourceIf.consequent) ? sourceIf.consequent : undefined;
    const sourceDeclaration = sourceBlock?.body[0];
    expect(t.isVariableDeclaration(sourceDeclaration)).toBe(true);
    expect(t.isVariableDeclaration(sourceDeclaration) ? sourceDeclaration.kind : undefined).toBe(kind);

    const transformedBody = selectedBody(deadCodeEliminatePass.run(parsed, source).program);
    expect(transformedBody[0]?.type).toBe("BlockStatement");
    const retainedDeclaration = t.isBlockStatement(transformedBody[0]) ? transformedBody[0].body[0] : undefined;
    expect(t.isVariableDeclaration(retainedDeclaration)).toBe(true);
    expect(t.isVariableDeclaration(retainedDeclaration) ? retainedDeclaration.kind : undefined).toBe(kind);
  });

  it("flattens only the selected outer block when a class remains protected by a nested block", () => {
    const source = "if (true) { { class Nested {} } globalThis.answer = typeof Nested; }";
    const expected: Execution = { completion: "normal", globals: { answer: "undefined" } };
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);

    expect(executeFresh(source, ["answer"])).toEqual(expected);
    expect(executeFresh(direct, ["answer"])).toEqual(expected);
    expect(executeFresh(pipeline.code, ["answer"])).toEqual(expected);
    expect(pipeline.warnings).toEqual([]);

    for (const code of [direct, pipeline.code]) {
      const body = parse(code).program.body;
      expect(body.map((statement) => statement.type)).toEqual(["BlockStatement", "ExpressionStatement"]);
      const nested = body[0];
      expect(t.isBlockStatement(nested) ? nested.body.map((statement) => statement.type) : []).toEqual([
        "ClassDeclaration",
      ]);
    }
  });

  const safeFlattenCases = [
    {
      name: "var-only",
      source: "if (true) { var value = 5; globalThis.inside = value; } globalThis.answer = typeof value + ':' + value;",
      observedGlobals: ["inside", "answer"],
    },
    {
      name: "expression-only",
      source: "if (false) { globalThis.answer = 0; } else { globalThis.answer = 9; } globalThis.after = globalThis.answer + 1;",
      observedGlobals: ["answer", "after"],
    },
  ] as const;

  it.each(safeFlattenCases)("keeps a $name selected body execution-equivalent and flattened", ({ source, observedGlobals }) => {
    const expected = executeFresh(source, [...observedGlobals]);
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);

    expect(executeFresh(direct, [...observedGlobals])).toEqual(expected);
    expect(executeFresh(pipeline.code, [...observedGlobals])).toEqual(expected);
    expect(pipeline.warnings).toEqual([]);
    expect(directProgram(source).body.some((statement) => t.isBlockStatement(statement))).toBe(false);
    expect(parse(pipeline.code).program.body.some((statement) => t.isBlockStatement(statement))).toBe(false);
  });

  it.each([
    { name: "default", unsafe: false },
    { name: "--unsafe", unsafe: true },
  ])("real CLI $name mode reaches the shared pass and preserves the exact class witness", ({ unsafe }) => {
    const source = "if (true) { class C {} } globalThis.answer = typeof C;";
    const result = runCli(source, unsafe);
    const warningsAndErrors = result.stderrLines.filter((line) => /^(WARNING|ERROR):/.test(line));

    expect(result.signal).toBeNull();
    expect(result.status, result.stderrLines.join("\n")).toBe(0);
    expect(warningsAndErrors).toEqual(unsafe ? [UNSAFE_NOTICE] : []);
    expect(result.stdoutLines.filter((line) => line.startsWith("Done: "))).toHaveLength(1);
    expect(result.output).toBeDefined();
    expect(executeFresh(result.output ?? "", ["answer"])).toEqual({
      completion: "normal",
      globals: { answer: "undefined" },
    });
  }, 120_000);

  const annexBCases = [
    {
      name: "S1 truthy consequent",
      source: "function outer() { if (true) { function f() { return 1; } } return f(); } globalThis.answer = outer();",
      answer: 1,
      withLexicalDeclaration: false,
    },
    {
      name: "S5 falsy alternate",
      source: "function outer() { if (false) { globalThis.dead = 1; } else { function g() { return 2; } } return g(); } globalThis.answer = outer();",
      answer: 2,
      withLexicalDeclaration: false,
    },
    {
      name: "P2 let plus function",
      source: "function outer() { if (true) { let z = 1; function f() { return z; } } return f(); } globalThis.answer = outer();",
      answer: 1,
      withLexicalDeclaration: true,
    },
  ] as const;

  it.each(annexBCases)("direct and default pipeline preserve Annex B outer binding for $name", ({ source, answer, withLexicalDeclaration }) => {
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);
    const expected: Execution = { completion: "normal", globals: { answer } };

    expectRetainedAnnexBBlock(direct, withLexicalDeclaration ? "present" : "absent");
    expectRetainedAnnexBBlock(pipeline.code, withLexicalDeclaration ? "unconstrained" : "absent");
    expect(pipeline.warnings).toEqual([]);
    expect(executeFresh(source, ["answer"])).toEqual(expected);
    expect(executeFresh(direct, ["answer"])).toEqual(expected);
    expect(executeFresh(pipeline.code, ["answer"])).toEqual(expected);
  });

  const annexBCliCases = annexBCases.flatMap((testCase) => [
    { ...testCase, mode: "default", unsafe: false },
    { ...testCase, mode: "--unsafe", unsafe: true },
  ]);

  it.each(annexBCliCases)("real CLI $mode preserves Annex B outer binding for $name", ({ source, answer, unsafe }) => {
    const result = runCli(source, unsafe);
    const warningsAndErrors = result.stderrLines.filter((line) => /^(WARNING|ERROR):/.test(line));

    expect(result.signal).toBeNull();
    expect(result.status, result.stderrLines.join("\n")).toBe(0);
    expect(warningsAndErrors).toEqual(unsafe ? [UNSAFE_NOTICE] : []);
    expect(result.stdoutLines.filter((line) => line.startsWith("Done: "))).toHaveLength(1);
    expect(result.output).toBeDefined();
    expect(executeFresh(result.output ?? "", ["answer"])).toEqual({
      completion: "normal",
      globals: { answer },
    });
  }, 120_000);

  const annexBCollisionCases = [
    {
      id: "R1 truthy var-before",
      source: "function outer() { var _0xf; if (true) { function _0xf() { return 1; } } return _0xf(); } globalThis.answer = outer();",
      baseAnswer: 1,
    },
    {
      id: "R2 falsy alternate",
      source: "function outer() { var _0xg; if (false) { globalThis.dead = 1; } else { function _0xg() { return 2; } } return _0xg(); } globalThis.answer = outer();",
      baseAnswer: 2,
    },
    {
      id: "R4 var-after",
      source: "function outer() { if (true) { function _0xf() { return 4; } } var _0xf; return _0xf(); } globalThis.answer = outer();",
      baseAnswer: 4,
    },
    {
      id: "R5 function-body duplicate",
      source: "function outer() { function _0xf() { return 0; } if (true) { function _0xf() { return 5; } } return _0xf(); } globalThis.answer = outer();",
      baseAnswer: 5,
    },
  ] as const;

  it.each(annexBCollisionCases)("preserves the source and immutable Base answer for $id at every production layer", ({ source, baseAnswer }) => {
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);
    const cliResults = [false, true].map((unsafe) => ({ unsafe, result: runCli(source, unsafe) }));
    const expected: Execution = { completion: "normal", globals: { answer: baseAnswer } };

    for (const { unsafe, result } of cliResults) {
      const warningsAndErrors = result.stderrLines.filter((line) => /^(WARNING|ERROR):/.test(line));
      expect(result.signal).toBeNull();
      expect(result.status, result.stderrLines.join("\n")).toBe(0);
      expect(warningsAndErrors).toEqual(unsafe ? [UNSAFE_NOTICE] : []);
      expect(result.stdoutLines.filter((line) => line.startsWith("Done: "))).toHaveLength(1);
      expect(result.output).toBeDefined();
    }

    expect({
      source: executeFresh(source, ["answer"]),
      direct: executeFresh(direct, ["answer"]),
      defaultPipeline: executeFresh(pipeline.code, ["answer"]),
      defaultCli: executeFresh(cliResults[0].result.output ?? "", ["answer"]),
      unsafeCli: executeFresh(cliResults[1].result.output ?? "", ["answer"]),
      pipelineWarnings: pipeline.warnings,
    }).toEqual({
      source: expected,
      direct: expected,
      defaultPipeline: expected,
      defaultCli: expected,
      unsafeCli: expected,
      pipelineWarnings: [],
    });
  }, 120_000);

  it.each(resolutionLinkedCases)(
    "preserves resolution-linked Annex B execution for $id $arm ($relationship)",
    ({ source, sentinel, useCli }) => {
      const direct = directCode(source);
      const pipeline = defaultPipeline(source);
      const cliResults = useCli
        ? [false, true].map((unsafe) => ({ unsafe, result: runCli(source, unsafe) }))
        : [];
      const expected: Execution = { completion: "normal", globals: { answer: sentinel } };

      for (const { unsafe, result } of cliResults) {
        const warningsAndErrors = result.stderrLines.filter((line) => /^(WARNING|ERROR):/.test(line));
        expect(result.signal).toBeNull();
        expect(result.status, result.stderrLines.join("\n")).toBe(0);
        expect(warningsAndErrors).toEqual(unsafe ? [UNSAFE_NOTICE] : []);
        expect(result.stdoutLines.filter((line) => line.startsWith("Done: "))).toHaveLength(1);
        expect(result.output).toBeDefined();
      }

      expect({
        source: executeFresh(source, ["answer"]),
        direct: executeFresh(direct, ["answer"]),
        defaultPipeline: executeFresh(pipeline.code, ["answer"]),
        defaultCli: cliResults[0]
          ? executeFresh(cliResults[0].result.output ?? "", ["answer"])
          : expected,
        unsafeCli: cliResults[1]
          ? executeFresh(cliResults[1].result.output ?? "", ["answer"])
          : expected,
        pipelineWarnings: pipeline.warnings,
      }).toEqual({
        source: expected,
        direct: expected,
        defaultPipeline: expected,
        defaultCli: expected,
        unsafeCli: expected,
        pipelineWarnings: [],
      });
    },
    120_000,
  );

  it("keeps Annex B protection resolution-linked and deterministic", () => {
    const protectedWithSibling = astRenameCode(
      "function outer() { var _0xf; var _0xa = 5; if (true) { function _0xf() { return 28; } } return _0xf() + _0xa; } globalThis.answer = outer();",
    );
    const mismatchedResolution = astRenameCode(
      "function outer() { var _0xf = 1; function inner(_0xf) { if (true) { function _0xf() {} } return typeof _0xf; } return _0xf + inner(2); } globalThis.answer = outer();",
    );
    const strictDeclaration = astRenameCode(
      "function outer() { 'use strict'; var _0xf; if (true) { function _0xf() {} } return typeof _0xf; } globalThis.answer = outer();",
    );

    expect({
      protectedNames: directVariableNames(protectedWithSibling),
      mismatchedNames: directVariableNames(mismatchedResolution),
      strictNames: directVariableNames(strictDeclaration),
    }).toEqual({
      protectedNames: ["_0xf", "other"],
      mismatchedNames: ["value"],
      strictNames: ["value"],
    });
  });

  it("removes an unreferenced block function nested in a strict function", () => {
    const source = "function outer() { 'use strict'; if (true) { function f() { return 1; } } return typeof f; } globalThis.answer = outer();";
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);
    const expected: Execution = { completion: "normal", globals: { answer: "undefined" } };

    expect(executeFresh(source, ["answer"])).toEqual(expected);
    expect(executeFresh(direct, ["answer"])).toEqual(expected);
    expect(executeFresh(pipeline.code, ["answer"])).toEqual(expected);
    expect(pipeline.warnings).toEqual([]);
    expect(selectedNestedBlockFunctionDeclarationCount(direct)).toBe(0);
    expect(selectedNestedBlockFunctionDeclarationCount(pipeline.code)).toBe(0);
  });

  it("still removes an ordinary unreferenced function declaration directly in a function body", () => {
    const source = "function outer() { function unused() { return 1; } return 2; } globalThis.answer = outer();";
    const direct = directCode(source);
    const pipeline = defaultPipeline(source);
    const expected: Execution = { completion: "normal", globals: { answer: 2 } };

    expect(directFunctionBodyDeclarationCount(source)).toBe(1);
    expect(directFunctionBodyDeclarationCount(direct)).toBe(0);
    expect(directFunctionBodyDeclarationCount(pipeline.code)).toBe(0);
    expect(pipeline.warnings).toEqual([]);
    expect(executeFresh(source, ["answer"])).toEqual(expected);
    expect(executeFresh(direct, ["answer"])).toEqual(expected);
    expect(executeFresh(pipeline.code, ["answer"])).toEqual(expected);
  });

  it.each(classOracleRows)(
    "class oracle $id $fingerprint ($classification)",
    ({ source: templateSource, observedGlobals, fingerprint, astRenameOuterNames, finalSelectedFunctionCounts, finalProgramBlockFunctionCounts }) => {
      const source = withFingerprint(templateSource, fingerprint);
      const expected = executeFresh(source, observedGlobals);
      const prefixes = productionPrefixExecutions(source, observedGlobals);

      expect(prefixes.warnings).toEqual([]);
      expect(prefixes.safe).toEqual(safeASTPasses.map(() => expected));
      expect(prefixes.all).toEqual(allASTPasses.map(() => expected));
      if (astRenameOuterNames) {
        expect(directVariableNames(astRenameCode(source))).toEqual(astRenameOuterNames);
      }
      if (finalSelectedFunctionCounts) {
        for (const passes of [safeASTPasses, allASTPasses]) {
          const result = runPipelineWithReport(source, passes, [formatPass]);
          expect(selectedNestedBlockFunctionDeclarationCount(result.code)).toBe(
            finalSelectedFunctionCounts[fingerprint],
          );
        }
      }
      if (finalProgramBlockFunctionCounts) {
        for (const passes of [safeASTPasses, allASTPasses]) {
          const result = runPipelineWithReport(source, passes, [formatPass]);
          const block = parse(result.code).program.body.find((statement) => t.isBlockStatement(statement));
          const count = t.isBlockStatement(block)
            ? block.body.filter((statement) => t.isFunctionDeclaration(statement)).length
            : 0;
          expect(count).toBe(finalProgramBlockFunctionCounts[fingerprint]);
        }
      }
    },
    120_000,
  );

  it.each(classOracleCliCases)(
    "class oracle real CLI $mode $id",
    ({ source: templateSource, observedGlobals, fingerprint, unsafe }) => {
      const source = withFingerprint(templateSource, fingerprint);
      const expected = executeFresh(source, observedGlobals);
      const result = runCli(source, unsafe);
      const warningsAndErrors = result.stderrLines.filter((line) => /^(WARNING|ERROR):/.test(line));

      expect(expected.completion).toBe("normal");
      expect(result.signal).toBeNull();
      expect(result.status, result.stderrLines.join("\n")).toBe(0);
      expect(warningsAndErrors).toEqual(unsafe ? [UNSAFE_NOTICE] : []);
      expect(result.stdoutLines.filter((line) => line.startsWith("Done: "))).toHaveLength(1);
      expect(result.output).toBeDefined();
      expect(executeFresh(result.output ?? "", observedGlobals)).toEqual(expected);
    },
    120_000,
  );

  it.each(activationOracleRows)(
    "activation oracle $id $fingerprint ($classification)",
    ({
      id,
      classification,
      source: templateSource,
      observedGlobals,
      fingerprint,
      expectedDirectVariableNames,
      expectedDirectParameterNames,
      expectedUnrelatedAssignmentType,
      warningBoundary,
      ...template
    }) => {
      const source = withFingerprint(templateSource, fingerprint);
      const sourceExecution = executeFresh(source, observedGlobals);
      const direct = directActivationConsumer(
        { id, classification, source: templateSource, observedGlobals, ...template },
        source,
      );
      const prefixes = productionPrefixExecutions(source, observedGlobals);
      const cleanedBC04: Execution = { completion: "normal", globals: { answer: 7 } };
      const prefixExpectation = (passes: typeof allASTPasses): Execution[] => passes.map((_, index) =>
        id === "BC04" && fingerprint === "active" &&
          passes.slice(0, index + 1).some((pass) => pass.name === "anti-debug")
          ? cleanedBC04
          : sourceExecution,
      );
      const directExpected = id === "BC04" && fingerprint === "active"
        ? cleanedBC04
        : sourceExecution;
      const expectedBC04Count = fingerprint === "active" ? 0 : 1;
      const boundary = warningBoundary && fingerprint === "inactive"
        ? warningBoundaryResult(warningBoundary)
        : undefined;

      expect({ direct: direct.warnings, prefixes: prefixes.warnings }).toEqual({
        direct: [],
        prefixes: [],
      });
      expect({
        source: sourceExecution,
        direct: direct.execution,
        safe: prefixes.safe,
        all: prefixes.all,
        directVariableNames: expectedDirectVariableNames
          ? directVariableNames(direct.code)
          : undefined,
        directParameterNames: expectedDirectParameterNames
          ? outerFunctionParameterNames(direct.code)
          : undefined,
        unrelatedAssignmentType: expectedUnrelatedAssignmentType
          ? globalAssignmentRightType(direct.code, "unrelated")
          : undefined,
        directBC04Count: id === "BC04"
          ? namedDirectBodyFunctionDeclarationCount(direct.code, "_0xdead")
          : undefined,
        warningBoundary: boundary,
      }).toEqual({
        source: sourceExecution,
        direct: directExpected,
        safe: prefixExpectation(safeASTPasses),
        all: prefixExpectation(allASTPasses),
        directVariableNames: expectedDirectVariableNames,
        directParameterNames: expectedDirectParameterNames,
        unrelatedAssignmentType: expectedUnrelatedAssignmentType,
        directBC04Count: id === "BC04" ? expectedBC04Count : undefined,
        warningBoundary: boundary
          ? {
              recoveredErrors: 1,
              pipelineWarning: true,
              cliStatus: 0,
              cliSignal: null,
              cliWarning: true,
              cliDoneLines: 1,
              cliOutputPresent: true,
              cleanBlockWarnings: [],
              cleanSwitchWarnings: [],
            }
          : undefined,
      });
    },
    120_000,
  );

  it.each(activationOracleCliCases)(
    "activation oracle real CLI $mode $id $fingerprint",
    ({ source: templateSource, observedGlobals, fingerprint, unsafe }) => {
      const source = withFingerprint(templateSource, fingerprint);
      const expected = executeFresh(source, observedGlobals);
      const result = runCli(source, unsafe);
      const warningsAndErrors = result.stderrLines.filter((line) => /^(WARNING|ERROR):/.test(line));

      expect({
        source: expected,
        signal: result.signal,
        status: result.status,
        warningsAndErrors,
        doneLines: result.stdoutLines.filter((line) => line.startsWith("Done: ")).length,
        outputPresent: result.output !== undefined,
        outputExecution: executeFresh(result.output ?? "", observedGlobals),
      }).toEqual({
        source: expected,
        signal: null,
        status: 0,
        warningsAndErrors: unsafe ? [UNSAFE_NOTICE] : [],
        doneLines: 1,
        outputPresent: true,
        outputExecution: expected,
      });
    },
    120_000,
  );

  it("pairwise destination property preserves every Base-correct selected row", () => {
    const failures: string[] = [];
    const classifications: Record<string, number> = { BASE_CORRECT: 0, BASE_WRONG: 0 };
    expect(baseCoveringOutcomes.map((row) => row.id)).toEqual(covering.rows.map(tupleId));
    for (const [index, row] of covering.rows.entries()) {
      const source = coveringProgram(row);
      const input = executeNormalized(source, observedCoveringGlobals);
      const baseline = baseCoveringOutcomes[index].outcome;
      const correct = JSON.stringify(input) === JSON.stringify(baseline);
      classifications[correct ? "BASE_CORRECT" : "BASE_WRONG"] += 1;
      for (const result of safeAndAll(source, observedCoveringGlobals)) {
        if (correct && (result.warnings.length || JSON.stringify(result.outcome) !== JSON.stringify(input))) {
          failures.push(tupleId(row) + "|" + result.layer);
        }
      }
    }
    expect(classifications).toEqual({ BASE_CORRECT: 49, BASE_WRONG: 7 });
    expect(failures).toEqual([]);
  }, 120_000);

  it("covering selection proves every valid pair and each retained row's unique tooth", () => {
    const inventory = coveringInventory();
    const covered = new Set(covering.rows.flatMap(obligations));
    expect({ valid: inventory.valid.length, rejected: inventory.rejected.length }).toEqual({ valid: 10944, rejected: 1152 });
    expect([...covered].sort()).toEqual(covering.universe);
    expect(covering.rows).toHaveLength(56);
    const invalidSources = inventory.valid.flatMap((row) => {
      const parsed = parseWithDiagnostics(coveringProgram(row));
      return parsed.completeness !== "whole" || parsed.recoveredErrors !== 0 || parsed.warnings.length ? [tupleId(row)] : [];
    });
    expect(invalidSources).toEqual([]);
    expect(covering.rows.some((row) => ["if_true", "if_false_alternate", "dead_code_injection"].includes(row.placement)
      && row.site !== "after_block" && row.declaration === "class")).toBe(true);
    expect(covering.rows.some((row) => ["bare_block", "switch_case", "non_constant_if"].includes(row.placement)
      && row.site !== "after_block" && ["async_function", "generator_function", "async_generator_function"].includes(row.declaration))).toBe(true);
    for (const row of covering.rows) {
      const tooth = covering.teeth[tupleId(row)];
      expect(tooth).not.toBe("");
      expect(obligations(row)).toContain(tooth);
      expect(covering.rows.filter((other) => obligations(other).includes(tooth))).toEqual([row]);
    }
  }, 120_000);

  it("exact Binding-site availability includes declaration, references and constant violations", () => {
    const failures: string[] = [];
    for (const row of covering.rows) {
      const source = coveringProgram(row);
      const ast = parse(source);
      const binding = getProbeBinding(ast);
      const sites = exactSites(binding);
      const destination = triggerSpecs[row.trigger].destination;
      const unavailable = sites.some((site) => site.scope.hasBinding(destination));
      let answerPath: SitePath | undefined;
      traverse(ast, { AssignmentExpression(path: SitePath & { node: t.AssignmentExpression }) {
        if (t.isMemberExpression(path.node.left) && t.isIdentifier(path.node.left.property, { name: "answer" })) answerPath = path;
      } });
      const within = (site: SitePath, ancestor: SitePath | undefined): boolean => {
        for (let current: SitePath | null = site; current; current = current.parentPath) if (current === ancestor) return true;
        return false;
      };
      const answerReferences = binding.referencePaths.filter((site) => within(site, answerPath));
      expect(answerReferences.length).toBeGreaterThan(0);
      expect(answerReferences.every((site) => site.scope.hasBinding(destination))).toBe(row.site !== "after_block");
      semanticRenamePass.run(ast, source);
      if (unavailable && binding.identifier.name === destination) failures.push(tupleId(row));
    }
    const writeSource = "var _0xv=[];_0xv.push(1);{class arr{} _0xv=[];}globalThis.answer=_0xv.length;";
    const ast = parse(writeSource);
    const binding = getProbeBinding(ast);
    expect(binding.path.scope.hasBinding("arr")).toBe(false);
    expect(binding.referencePaths.some((site) => site.scope.hasBinding("arr"))).toBe(false);
    expect(binding.constantViolations.map((site) => site.scope.hasBinding("arr"))).toEqual([true]);
    expect(exactSites(binding).length).toBe(new Set([binding.path, ...binding.referencePaths, ...binding.constantViolations]).size);
    semanticRenamePass.run(ast, writeSource);
    if (binding.identifier.name === "arr") failures.push("constant-violation-only");
    expect(executeNormalized(generate(ast), ["answer"])).toEqual(executeNormalized(writeSource, ["answer"]));
    expect(failures).toEqual([]);
  });

  it("Annex B reservation follows exact Binding owner sites and preserves unrelated first-safe names", () => {
    const rows = [
      { polarity: "positive", expected: "items", source: "var _0xv=[];_0xv.push(1);function owner(){if(true){function arr(){}}globalThis.answer=_0xv.length;}owner();" },
      { polarity: "unrelated", expected: "arr", source: "var _0xv=[];_0xv.push(1);function unrelated(){if(true){function arr(){}}return 3;}globalThis.other=unrelated();globalThis.answer=_0xv.length;" },
    ];
    for (const row of rows) {
      const ast = parse(row.source);
      const binding = getProbeBinding(ast);
      let owner: SitePath | undefined;
      traverse(ast, { FunctionDeclaration(path: SitePath & { node: t.FunctionDeclaration }) {
        if (path.node.id?.name !== "arr") return;
        for (let current = path.parentPath; current; current = current.parentPath) {
          if (t.isFunction(current.node) || t.isProgram(current.node)) { owner = current; break; }
        }
      } });
      expect(owner).toBeDefined();
      const ownerRelevant = exactSites(binding).some((site) => {
        for (let current: SitePath | null = site; current; current = current.parentPath) if (current === owner) return true;
        return false;
      });
      expect(ownerRelevant).toBe(row.polarity === "positive");
      semanticRenamePass.run(ast, row.source);
      expect({ polarity: row.polarity, name: binding.identifier.name }).toEqual({ polarity: row.polarity, name: row.expected });
      expect(executeNormalized(generate(ast), ["answer", "other"])).toEqual(executeNormalized(row.source, ["answer", "other"]));
    }
  });

  it("position-less proxy clone and direct control preserve exact Binding schedules", () => {
    for (const shape of ["proxy-clone", "direct-control"] as const) {
      const source = cloneRepresentative(shape);
      const expected = executeNormalized(source, ["r1", "answer", "__cx02Fingerprint"]);
      const bindingShape = positionlessBindingShape(source);
      expect(bindingShape.distinct).toBe(3);
      if (shape === "proxy-clone") expect(bindingShape.starts).toEqual([null, null, null]);
      else expect(bindingShape.starts.every((start) => start !== null)).toBe(true);
      for (const result of safeAndAll(source, ["r1", "answer", "__cx02Fingerprint"])) {
        expect(result.warnings).toEqual([]);
        expect(result.outcome).toEqual(expected);
        expect(declarationCounts(result.code, ["_0xf", "items"])).toEqual({ _0xf: 2, items: 1 });
      }
    }
  });

  it("bundler-unpack invokes both extracted position-less modules with lexical destinations", () => {
    expect(bundlerPositionlessBindingShape(BUNDLER_POSITIONLESS_SOURCE)).toEqual({ distinct: 3, starts: [null, null, null] });
    for (const passes of [safeASTPasses, allASTPasses]) {
      const result = runPipelineWithReport(BUNDLER_POSITIONLESS_SOURCE, passes, [formatPass]);
      expect(result.warnings).toEqual([]);
      const modules = parse(result.code).program.body.filter((node) => t.isFunctionDeclaration(node));
      expect(modules).toHaveLength(2);
      for (const [index, module] of modules.entries()) {
        const call = "var module={exports:{}};" + module.id?.name + "(module,module.exports,function(){});globalThis.answer=module.exports;";
        const source = "(" + BUNDLER_MODULES[index] + ")(module,module.exports,function(){});globalThis.answer=module.exports;";
        expect(executeNormalized(result.code + call, ["answer"]))
          .toEqual(executeNormalized("var module={exports:{}};" + source, ["answer"]));
      }
    }
  });

  it.each([{ mode: "default", unsafe: false }, { mode: "--unsafe", unsafe: true }])(
    "destination capture reaches the real CLI $mode", ({ unsafe }) => {
      const source = "var _0xv=[];_0xv.push(1);if(true){class arr{}globalThis.answer=_0xv.length;}";
      const result = runCli(source, unsafe);
      expect({ signal: result.signal, status: result.status,
        messages: result.stderrLines.filter((line) => /^(WARNING|ERROR):/.test(line)),
        done: result.stdoutLines.filter((line) => line.startsWith("Done: ")).length,
        present: result.output !== undefined,
        outcome: executeNormalized(result.output ?? "", ["answer"]),
      }).toEqual({ signal: null, status: 0, messages: unsafe ? [UNSAFE_NOTICE] : [], done: 1, present: true,
        outcome: executeNormalized(source, ["answer"]),
      });
    }, 120_000,
  );

  it.each(linkageRows)("consumer linkage representative: $id", ({ source, passes }) => {
    const expected = executeNormalized(source, ["answer"]);
    const direct = runPipelineWithReport(source, [...passes], [formatPass]);
    const production = safeAndAll(source, ["answer"]);
    expect({
      directWarnings: direct.warnings,
      direct: executeNormalized(direct.code, ["answer"]),
      productionWarnings: production.flatMap(({ warnings }) => warnings),
      production: production.map(({ outcome }) => outcome),
    }).toEqual({
      directWarnings: [],
      direct: expected,
      productionWarnings: [],
      production: [expected, expected],
    });
  });

});
