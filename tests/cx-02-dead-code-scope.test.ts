import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { t } from "../src/babel.js";
import { allASTPasses } from "../src/cli-shared.js";
import { generate, parse } from "../src/parser.js";
import { deadCodeEliminatePass } from "../src/passes/dead-code-eliminate.js";
import { formatPass } from "../src/passes/format.js";
import { astRenamePass } from "../src/passes/ast-rename.js";
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

describe("CX-02 selected dead-code branch scope preservation", () => {
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
});
