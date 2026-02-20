/**
 * De-obfuscation pipeline — supports both AST-based and token-based passes.
 *
 * AST pipeline: parse once → transform N → generate once
 * Token pipeline: string → string (legacy, used for format pass)
 * Full pipeline: AST passes first, then token passes on generated output
 */

import type { ASTPass, TokenPass, PipelineContext } from "./types.js";
import { parse, parseWithDiagnostics, generate } from "./parser.js";
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
}

/** Run full pipeline with structured output including per-pass reports and warnings. */
export function runPipelineWithReport(
  source: string,
  astPasses: ASTPass[],
  tokenPasses: TokenPass[],
): PipelineResult {
  const warnings: string[] = [];
  const report: PassReport[] = [];

  const maxIterations = 3;
  let currentSource = source;
  let { ast, warnings: parseWarnings } = parseWithDiagnostics(currentSource);
  warnings.push(...parseWarnings);

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
      ast = pass.run(ast, currentSource, context);
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
    previousCode = currentCode;
    if (i < maxIterations - 1) {
      currentSource = currentCode;
      const reparse = parseWithDiagnostics(currentSource);
      ast = reparse.ast;
      warnings.push(...reparse.warnings);
    }
  }

  // QW4: Compute final entropy
  const finalEntropy = identifierEntropy(ast);

  let code = previousCode || generate(ast);
  for (const pass of tokenPasses) {
    const before = code;
    code = pass.run(code);
    report.push({ name: pass.name, changed: before !== code });
  }

  return { code, warnings, report, iterations, initialEntropy, finalEntropy };
}
