import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { traverse, t } from "../src/babel.js";
import { allASTPasses } from "../src/cli-shared.js";
import { fingerprint } from "../src/fingerprint.js";
import { parse, generate } from "../src/parser.js";
import { filterSafePasses, runPipelineWithReport } from "../src/pipeline.js";
import { controlFlowUnflattenPass } from "../src/passes/control-flow-unflatten.js";
import { formatPass } from "../src/passes/format.js";

const PROGRAM_TIMEOUT_MS = 2_000;
const LOOP_TIMEOUT_MS = 250;

interface Execution {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function executeProgram(source: string, timeout = PROGRAM_TIMEOUT_MS): Execution {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

function transform(source: string): { before: string; code: string; changed: boolean } {
  const ast = parse(source);
  const before = generate(ast);
  const code = generate(controlFlowUnflattenPass.run(ast, source));
  return { before, code, changed: code !== before };
}

function arithmeticSwitchCount(source: string): number {
  let count = 0;
  traverse(parse(source), {
    SwitchStatement(path: { node: { discriminant: t.Expression } }) {
      if (t.isIdentifier(path.node.discriminant)) count++;
    },
  });
  return count;
}

function expectSuccessfulOutput(execution: Execution, expected: string): void {
  expect(execution.timedOut).toBe(false);
  expect(execution.status).toBe(0);
  expect(execution.signal).toBeNull();
  expect(execution.stderr).toBe("");
  expect(execution.stdout).toBe(expected);
}

function terminalWorkSource(): string {
  return `
    var _0xstate = 0, _0xpad1 = 1, _0xpad2 = 2;
    globalThis.keep = 1;
    while (true) {
      switch (_0xstate) {
        case 0: globalThis.pre = 7; _0xstate = 1; continue;
        case 1: globalThis.answer = 42; break;
      }
      break;
    }
    process.stdout.write(JSON.stringify({pre: globalThis.pre ?? null, answer: globalThis.answer ?? null, keep: globalThis.keep ?? null}));
  `;
}

function overLimitSource(): string {
  const cases: string[] = [];
  for (let state = 0; state < 1_001; state++) {
    cases.push(`case ${state}: globalThis.count++; _0xstate = ${state + 1}; continue;`);
  }
  cases.push("case 1001: globalThis.terminal = true; break;");
  return `var _0xstate=0; globalThis.count=0; while(true){switch(_0xstate){${cases.join("\n")}} break;} process.stdout.write(JSON.stringify({count:globalThis.count,terminal:globalThis.terminal===true}));`;
}

describe("arithmetic control-flow unflattening preserves program behavior", () => {
  it("keeps reachable work from the terminal case in the direct pass and default pipeline", () => {
    const source = terminalWorkSource();
    const expected = '{"pre":7,"answer":42,"keep":1}';
    expect(fingerprint(parse(source)).obfuscator).not.toBeNull();
    expectSuccessfulOutput(executeProgram(source), expected);

    const direct = transform(source);
    const directExecution = executeProgram(direct.code);
    const pipeline = runPipelineWithReport(source, filterSafePasses(allASTPasses), [formatPass]);
    const pipelineExecution = executeProgram(pipeline.code);
    const unflattenReports = pipeline.report.filter(({ name }) => name === "control-flow-unflatten");

    expect(direct.changed).toBe(true);
    expect(arithmeticSwitchCount(direct.code)).toBe(0);
    expectSuccessfulOutput(directExecution, expected);
    expect(unflattenReports.some(({ changed }) => changed)).toBe(true);
    expect(pipeline.warnings).toEqual([]);
    expect(arithmeticSwitchCount(pipeline.code)).toBe(0);
    expectSuccessfulOutput(pipelineExecution, expected);
  });

  it("refuses a repeated-state trace whose syntactic terminal is unreachable", () => {
    const source = `
      var _0xstate = 0;
      globalThis.count = 0;
      while (true) {
        switch (_0xstate) {
          case 0: globalThis.count++; _0xstate = 1; continue;
          case 1: globalThis.count++; _0xstate = 0; continue;
          case 2: globalThis.terminal = true; break;
        }
        break;
      }
      process.stdout.write(String(globalThis.count));
    `;
    const transformed = transform(source);
    const sourceExecution = executeProgram(source, LOOP_TIMEOUT_MS);
    const transformedExecution = executeProgram(transformed.code, LOOP_TIMEOUT_MS);

    expect(sourceExecution.timedOut).toBe(true);
    expect(sourceExecution.signal).toBe("SIGKILL");
    expect(transformed.changed).toBe(false);
    expect(arithmeticSwitchCount(transformed.code)).toBe(1);
    expect(transformedExecution.timedOut).toBe(true);
    expect(transformedExecution.signal).toBe("SIGKILL");
  });

  it("refuses a terminal-reaching trace that needs a 1001st visited state", () => {
    const source = overLimitSource();
    const expected = '{"count":1001,"terminal":true}';
    const transformed = transform(source);
    const sourceExecution = executeProgram(source);
    const transformedExecution = executeProgram(transformed.code);

    expectSuccessfulOutput(sourceExecution, expected);
    expect(transformed.changed).toBe(false);
    expect(arithmeticSwitchCount(transformed.code)).toBe(1);
    expectSuccessfulOutput(transformedExecution, expected);
  });

  it("refuses duplicate numeric labels and preserves first-match behavior", () => {
    const source = `
      var _0xstate = 0;
      while (true) {
        switch (_0xstate) {
          case 0: globalThis.answer = "first"; _0xstate = 1; continue;
          case 0: globalThis.answer = "second"; _0xstate = 1; continue;
          case 1: break;
        }
        break;
      }
      process.stdout.write(String(globalThis.answer));
    `;
    const transformed = transform(source);
    const sourceExecution = executeProgram(source);
    const transformedExecution = executeProgram(transformed.code);

    expectSuccessfulOutput(sourceExecution, "first");
    expect(transformed.changed).toBe(false);
    expect(arithmeticSwitchCount(transformed.code)).toBe(1);
    expectSuccessfulOutput(transformedExecution, "first");
  });

  it("refuses multiple state assignments when an intervening read is observable", () => {
    const source = `
      var _0xstate = 0;
      while (true) {
        switch (_0xstate) {
          case 0: _0xstate = 5; globalThis.seen = _0xstate; _0xstate = _0xstate + 2; continue;
          case 2: break;
        }
        break;
      }
      process.stdout.write(String(globalThis.seen));
    `;
    const transformed = transform(source);
    const sourceExecution = executeProgram(source);
    const transformedExecution = executeProgram(transformed.code);

    expectSuccessfulOutput(sourceExecution, "5");
    expect(transformed.changed).toBe(false);
    expect(arithmeticSwitchCount(transformed.code)).toBe(1);
    expectSuccessfulOutput(transformedExecution, "5");
  });

  it("preserves state observed in the terminal case and after the dispatcher", () => {
    const source = `
      var _0xstate = 0;
      while (true) {
        switch (_0xstate) {
          case 0: _0xstate = 1; continue;
          case 1: globalThis.inTerminal = _0xstate; break;
        }
        break;
      }
      globalThis.after = _0xstate;
      process.stdout.write(JSON.stringify({inTerminal: globalThis.inTerminal, after: globalThis.after}));
    `;
    const expected = '{"inTerminal":1,"after":1}';
    const transformed = transform(source);
    const sourceExecution = executeProgram(source);
    const transformedExecution = executeProgram(transformed.code);

    expectSuccessfulOutput(sourceExecution, expected);
    expectSuccessfulOutput(transformedExecution, expected);
    expect(arithmeticSwitchCount(transformed.code)).toBe(transformed.changed ? 0 : 1);
  });

  it("refuses an unmodelled update before the recognized state assignment", () => {
    const source = `
      var _0xstate = 0, _0xpad = 1;
      while (true) {
        switch (_0xstate) {
          case 0: _0xstate++; _0xstate = _0xstate + 1; continue;
          case 1: globalThis.selected = "wrong"; break;
          case 2: globalThis.selected = "right"; break;
        }
        break;
      }
      process.stdout.write(String(globalThis.selected));
    `;
    const transformed = transform(source);
    const sourceExecution = executeProgram(source);
    const transformedExecution = executeProgram(transformed.code);

    expectSuccessfulOutput(sourceExecution, "right");
    expect({
      timedOut: transformedExecution.timedOut,
      status: transformedExecution.status,
      signal: transformedExecution.signal,
      stderr: transformedExecution.stderr,
      stdout: transformedExecution.stdout,
      changed: transformed.changed,
      arithmeticSwitches: arithmeticSwitchCount(transformed.code),
    }).toEqual({
      timedOut: false,
      status: 0,
      signal: null,
      stderr: "",
      stdout: "right",
      changed: false,
      arithmeticSwitches: 1,
    });
  });

  it("refuses a same-binding reassignment before loop entry", () => {
    const source = `
      var _0xstate = 0, _0xpad = 1;
      _0xstate = 1;
      while (true) {
        switch (_0xstate) {
          case 0: globalThis.selected = "wrong"; break;
          case 1: globalThis.selected = "right"; break;
        }
        break;
      }
      process.stdout.write(String(globalThis.selected));
    `;
    const transformed = transform(source);
    const sourceExecution = executeProgram(source);
    const transformedExecution = executeProgram(transformed.code);

    expectSuccessfulOutput(sourceExecution, "right");
    expect({
      timedOut: transformedExecution.timedOut,
      status: transformedExecution.status,
      signal: transformedExecution.signal,
      stderr: transformedExecution.stderr,
      stdout: transformedExecution.stdout,
      changed: transformed.changed,
      arithmeticSwitches: arithmeticSwitchCount(transformed.code),
    }).toEqual({
      timedOut: false,
      status: 0,
      signal: null,
      stderr: "",
      stdout: "right",
      changed: false,
      arithmeticSwitches: 1,
    });
  });

  it("keeps the existing refusal for a transition to a missing state", () => {
    const source = `
      var _0xstate = 0;
      globalThis.count = 0;
      while (true) {
        switch (_0xstate) {
          case 0: globalThis.count++; _0xstate = 99; continue;
          case 1: break;
        }
        break;
      }
      process.stdout.write(String(globalThis.count));
    `;
    const transformed = transform(source);

    expect(transformed.changed).toBe(false);
    expect(arithmeticSwitchCount(transformed.code)).toBe(1);
    expectSuccessfulOutput(executeProgram(source), "1");
    expectSuccessfulOutput(executeProgram(transformed.code), "1");
  });

  const supportedTransitions = [
    {
      name: "constant",
      initial: 0,
      firstLabel: 0,
      firstTransition: "_0xstate = 2",
      secondLabel: 2,
      secondTransition: "_0xstate = -1",
      terminalLabel: -1,
    },
    {
      name: "additive",
      initial: 0,
      firstLabel: 0,
      firstTransition: "_0xstate = _0xstate + 2",
      secondLabel: 2,
      secondTransition: "_0xstate = -1",
      terminalLabel: -1,
    },
    {
      name: "affine",
      initial: 1,
      firstLabel: 1,
      firstTransition: "_0xstate = _0xstate * 2 + 1",
      secondLabel: 3,
      secondTransition: "_0xstate = 0",
      terminalLabel: 0,
    },
    {
      name: "XOR",
      initial: 10,
      firstLabel: 10,
      firstTransition: "_0xstate = _0xstate ^ 7",
      secondLabel: 13,
      secondTransition: "_0xstate = 15",
      terminalLabel: 15,
    },
  ] as const;

  it.each(supportedTransitions)("still linearizes a valid $name terminal-reaching trace", (shape) => {
    const source = `
      var _0xstate = ${shape.initial};
      globalThis.effects = [];
      while (true) {
        switch (_0xstate) {
          case ${shape.firstLabel}: globalThis.effects.push("${shape.name}:first"); ${shape.firstTransition}; continue;
          case ${shape.secondLabel}: globalThis.effects.push("${shape.name}:second"); ${shape.secondTransition}; continue;
          case ${shape.terminalLabel}: break;
        }
        break;
      }
      process.stdout.write(JSON.stringify(globalThis.effects));
    `;
    const expected = JSON.stringify([`${shape.name}:first`, `${shape.name}:second`]);
    const transformed = transform(source);

    expect(transformed.changed).toBe(true);
    expect(arithmeticSwitchCount(transformed.code)).toBe(0);
    expectSuccessfulOutput(executeProgram(source), expected);
    expectSuccessfulOutput(executeProgram(transformed.code), expected);
  });
});
