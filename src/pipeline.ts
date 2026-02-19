/**
 * De-obfuscation pipeline — supports both AST-based and token-based passes.
 *
 * AST pipeline: parse once → transform N → generate once
 * Token pipeline: string → string (legacy, used for format pass)
 * Full pipeline: AST passes first, then token passes on generated output
 */

import type { ASTPass, TokenPass } from "./types.js";
import { parse, generate } from "./parser.js";

/** Run AST passes: parse once, transform N times, generate once. */
export function runASTPipeline(source: string, passes: ASTPass[]): string {
  let ast = parse(source);
  for (const pass of passes) {
    ast = pass.run(ast);
  }
  return generate(ast);
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
  const afterAST = runASTPipeline(source, astPasses);
  return runTokenPipeline(afterAST, tokenPasses);
}
