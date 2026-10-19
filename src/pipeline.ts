/**
 * De-obfuscation pipeline — supports both AST-based and token-based passes.
 *
 * AST pipeline: parse once → transform N → generate once
 * Token pipeline: string → string (legacy, used for format pass)
 * Full pipeline: AST passes first, then token passes on generated output
 */

import type { ASTPass, TokenPass, PipelineContext } from "./types.js";
import type { File } from "@babel/types";
import { parse, parseWithDiagnostics, generate } from "./parser.js";
import type { ParseOutcome, ParseResult } from "./parser.js";
import { fingerprint } from "./fingerprint.js";
import { identifierEntropy } from "./entropy.js";

export interface ASTPipelineOptions {
  maxIterations?: number;
}

/** Pass names that target javascript-obfuscator patterns specifically. */
const OBFUSCATOR_SPECIFIC_PASSES = new Set([
  "string-array",
  "control-flow-object",
  "control-flow-unflatten",
  "anti-debug",
]);

/**
 * Run AST passes with iterative convergence.
 * Repeats all passes until the output stabilizes or maxIterations is reached.
 */
export function runASTPipeline(
  source: string,
  passes: ASTPass[],
  options?: ASTPipelineOptions,
): string {
  const maxIterations = options?.maxIterations ?? 1;
  let currentSource = source;
  let ast = parse(currentSource);
  let previousCode = "";

  for (let i = 0; i < maxIterations; i++) {
    for (const pass of passes) {
      ast = pass.run(ast, currentSource);
    }
    const currentCode = generate(ast);
    if (currentCode === previousCode) {
      return currentCode;
    }
    previousCode = currentCode;
    if (i < maxIterations - 1) {
      currentSource = currentCode;
      ast = parse(currentSource);
    }
  }

  return previousCode;
}

/** Run token-level passes sequentially on a string. */
export function runTokenPipeline(source: string, passes: TokenPass[]): string {
  let result = source;
  for (const pass of passes) {
    result = pass.run(result);
  }
  return result;
}

/** Run full deobfuscation: AST passes first, then token passes. */
export function runPipeline(
  source: string,
  astPasses: ASTPass[],
  tokenPasses: TokenPass[],
): string {
  const afterAST = runASTPipeline(source, astPasses, { maxIterations: 3 });
  return runTokenPipeline(afterAST, tokenPasses);
}

/** Filter out passes marked as unsafe. Passes without a safety field are treated as safe. */
export function filterSafePasses(passes: ASTPass[]): ASTPass[] {
  return passes.filter(p => p.safety !== "unsafe");
}

export interface PassReport {
  name: string;
  changed: boolean;
}

export interface PipelineResult {
  code: string;
  warnings: string[];
  report: PassReport[];
  iterations: number;
  initialEntropy: number;
  finalEntropy: number;
  /** Outcome of parsing the original input. */
  initialParse: ParseOutcome;
  /** Statements plus directives of the program parsed from the input. */
  inputStatementCount: number;
  /** Statements plus directives of the program that produced `code` (before the token passes). */
  finalStatementCount: number;
}

/**
 * Run full pipeline with structured output including per-pass reports and warnings.
 *
 * A pass (AST or token) that throws is skipped: its partial effects are undone,
 * a warning "<pass name>: <message>" is recorded and the remaining passes run.
 * An iteration whose generated code does not re-parse completely is discarded.
 * Any other error propagates, carrying the warnings collected so far
 * (read them with `warningsOf`).
 */
export function runPipelineWithReport(
  source: string,
  astPasses: ASTPass[],
  tokenPasses: TokenPass[],
): PipelineResult {
  const warnings: string[] = [];
  try {
    return runReported(source, astPasses, tokenPasses, warnings);
  } catch (thrown: unknown) {
    // Not a pass failure or a discarded iteration (both are absorbed inside):
    // keep the warnings recoverable and propagate.
    throw withWarnings(thrown, warnings);
  }
}

/** The warnings carried by a value thrown out of runPipelineWithReport ([] for any other value). */
export function warningsOf(thrown: unknown): string[] {
  if ((typeof thrown !== "object" && typeof thrown !== "function") || thrown === null) return [];
  const carried = (thrown as { warnings?: unknown }).warnings;
  return Array.isArray(carried) && carried.every((w) => typeof w === "string") ? [...carried] : [];
}

function withWarnings(thrown: unknown, warnings: string[]): unknown {
  const carried = { value: [...warnings], configurable: true, writable: true };
  // An object (Error or not) is rethrown as itself; a primitive is wrapped so its string form survives.
  if ((typeof thrown === "object" || typeof thrown === "function") && thrown !== null && Reflect.defineProperty(thrown, "warnings", carried)) {
    return thrown;
  }
  const wrapped = new Error(printable(thrown), { cause: thrown });
  Object.defineProperty(wrapped, "warnings", carried);
  return wrapped;
}

function printable(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function thrownMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : printable(thrown);
}

function statementCount(ast: File): number {
  return ast.program.body.length + ast.program.directives.length;
}

function outcomeOf(parsed: ParseResult): ParseOutcome {
  const { completeness, mode, recoveredErrors, truncatedAtLine } = parsed;
  return truncatedAtLine === undefined
    ? { completeness, mode, recoveredErrors }
    : { completeness, mode, recoveredErrors, truncatedAtLine };
}

/**
 * Deep copy of the pass state that keeps prototypes, every own field (Error
 * fields included) and the object sharing inside the value (e.g. comments
 * referenced from both a node and File.comments). Functions are kept by reference.
 * Built-in containers (Map, Set, Date, RegExp, binary data) go through structuredClone.
 */
function copyState<T>(value: T): T {
  return copyValue(value, new Map()) as T;
}

function copyValue(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value !== "object" || value === null) return value;
  const known = seen.get(value);
  if (known !== undefined) return known;

  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) copy[i] = copyValue(value[i], seen);
    return copy;
  }
  if (value instanceof Map || value instanceof Set || value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const copy = structuredClone(value);
    seen.set(value, copy);
    return copy;
  }

  const source = value as Record<string, unknown>;
  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, copy);
  if (value instanceof Error) {
    // message and stack are own non-enumerable properties: copy every descriptor
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if ("value" in descriptor) descriptor.value = copyValue(descriptor.value, seen);
      Object.defineProperty(copy, key, descriptor);
    }
    return copy;
  }
  for (const key of Object.keys(source)) copy[key] = copyValue(source[key], seen);
  return copy;
}

type PassOutcome = { ok: true; ast: File } | { ok: false; restored: File; message: string };

/**
 * Run one AST pass transactionally. The governed state is (ast, context): it is
 * deep-copied before the pass, and on a throw the copy of the AST is handed on
 * and the context is restored in place (same object, same metadata object).
 *
 * Restoring by re-running the iteration without the failing pass would execute
 * the passes before it a second time, so the state is copied up front instead.
 */
function runASTPassTransactional(pass: ASTPass, ast: File, source: string, context: PipelineContext): PassOutcome {
  const metadata = context.metadata;
  const saved = copyState({ ast, context });
  try {
    return { ok: true, ast: pass.run(ast, source, context) };
  } catch (thrown: unknown) {
    const live = context as unknown as Record<string, unknown>;
    for (const key of Object.keys(live)) {
      if (!(key in saved.context)) delete live[key];
    }
    for (const [key, value] of Object.entries(saved.context)) {
      if (key !== "metadata") live[key] = value;
    }
    for (const key of Object.keys(metadata)) delete metadata[key];
    Object.assign(metadata, saved.context.metadata);
    context.metadata = metadata;
    return { ok: false, restored: saved.ast, message: thrownMessage(thrown) };
  }
}

type Reparse = { ok: true; parsed: ParseResult } | { ok: false; condition: string };

const COMPLETENESS_RANK: Record<ParseOutcome["completeness"], number> = { whole: 2, truncated: 1, empty: 0 };

/**
 * Re-parse generated code. It is a discard condition only when the re-parse is
 * worse than the initial parse of the input: it throws, it is less complete, or
 * it recovers from more errors. The parse mode is not considered.
 */
function reparseGenerated(code: string, initial: ParseOutcome): Reparse {
  let parsed: ParseResult;
  try {
    parsed = parseWithDiagnostics(code);
  } catch (thrown: unknown) {
    return { ok: false, condition: `the re-parse of the generated code threw an error (${thrownMessage(thrown)})` };
  }
  if (COMPLETENESS_RANK[parsed.completeness] < COMPLETENESS_RANK[initial.completeness]) {
    const how = parsed.completeness === "empty"
      ? "fell back to an empty program"
      : `was truncated at line ${parsed.truncatedAtLine}`;
    return { ok: false, condition: `the re-parse of the generated code ${how}, but the input parsed ${initial.completeness === "whole" ? "whole" : "further"}` };
  }
  if (parsed.recoveredErrors > initial.recoveredErrors) {
    return { ok: false, condition: `the re-parse of the generated code recovered from ${parsed.recoveredErrors} error(s), more than the ${initial.recoveredErrors} of the input` };
  }
  return { ok: true, parsed };
}

function runReported(
  source: string,
  astPasses: ASTPass[],
  tokenPasses: TokenPass[],
  warnings: string[],
): PipelineResult {
  const report: PassReport[] = [];

  const maxIterations = 3;
  let currentSource = source;
  const initial = parseWithDiagnostics(currentSource);
  let ast = initial.ast;
  warnings.push(...initial.warnings);
  const initialParse = outcomeOf(initial);
  const inputStatementCount = statementCount(ast);

  // QW1: Create pipeline context
  const context: PipelineContext = { metadata: {} };

  // QW2: Run fingerprint and store in context
  const fp = fingerprint(ast);
  context.fingerprint = fp;
  const hasObfuscator = fp.obfuscator !== null;

  // QW4: Compute initial entropy
  const initialEntropy = identifierEntropy(ast);

  let previousCode = "";
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations++;
    let anyChanged = false;

    for (const pass of astPasses) {
      // QW2: Skip obfuscator-specific passes when no obfuscator detected
      if (!hasObfuscator && OBFUSCATOR_SPECIFIC_PASSES.has(pass.name)) {
        continue;
      }

      const before = generate(ast);
      const outcome = runASTPassTransactional(pass, ast, currentSource, context);
      if (!outcome.ok) {
        ast = outcome.restored;
        warnings.push(`${pass.name}: ${outcome.message}`);
        report.push({ name: pass.name, changed: false });
        continue;
      }
      ast = outcome.ast;
      const after = generate(ast);
      const changed = before !== after;
      report.push({ name: pass.name, changed });
      if (changed) anyChanged = true;
    }

    // QW3: Early termination when no passes changed anything
    if (!anyChanged) {
      break;
    }

    const currentCode = generate(ast);
    if (currentCode === previousCode) {
      break;
    }
    if (i < maxIterations - 1) {
      const reparse = reparseGenerated(currentCode, initialParse);
      if (!reparse.ok) {
        // Discard this iteration: go back to the state it started from
        // (re-parsing that source rebinds the AST offsets to it) and stop iterating.
        ast = parseWithDiagnostics(currentSource).ast;
        warnings.push(`Discarded iteration ${iterations}: ${reparse.condition}; kept the state from before that iteration`);
        break;
      }
      previousCode = currentCode;
      currentSource = currentCode;
      ast = reparse.parsed.ast;
      warnings.push(...reparse.parsed.warnings);
    } else {
      previousCode = currentCode;
    }
  }

  // QW4: Compute final entropy
  const finalEntropy = identifierEntropy(ast);
  const finalStatementCount = statementCount(ast);

  let code = previousCode || generate(ast);
  for (const pass of tokenPasses) {
    const before = code;
    try {
      code = pass.run(code);
    } catch (thrown: unknown) {
      // A throwing token pass leaves the text as it was.
      warnings.push(`${pass.name}: ${thrownMessage(thrown)}`);
      report.push({ name: pass.name, changed: false });
      continue;
    }
    report.push({ name: pass.name, changed: before !== code });
  }

  return {
    code,
    warnings,
    report,
    iterations,
    initialEntropy,
    finalEntropy,
    initialParse,
    inputStatementCount,
    finalStatementCount,
  };
}
