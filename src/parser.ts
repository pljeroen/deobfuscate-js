/**
 * Babel-based JavaScript parser and code generator.
 * Single parse -> multiple transforms -> single generate.
 *
 * R19: Multi-parser fallback — if errorRecovery parse still throws,
 * truncate to the valid prefix before the error line.
 */

import { parse as babelParse, generate as babelGenerate } from "./babel.js";
import type { File } from "@babel/types";

const PARSE_OPTIONS = {
  sourceType: "unambiguous" as const,
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
  errorRecovery: true,
  plugins: ["dynamicImport", "optionalChaining", "nullishCoalescingOperator"] as const,
};

export function parse(source: string): File {
  try {
    return babelParse(source, PARSE_OPTIONS);
  } catch (e: unknown) {
    // Fallback: try sourceType "script" (avoids module-detection ambiguity)
    try {
      return babelParse(source, { ...PARSE_OPTIONS, sourceType: "script" });
    } catch {
      // noop — fall through to truncation
    }

    // Truncation fallback: parse valid prefix before the error line
    if (e instanceof SyntaxError && typeof (e as any).loc?.line === "number") {
      const errorLine: number = (e as any).loc.line;
      const lines = source.split("\n");
      const partialSource = lines.slice(0, errorLine - 1).join("\n");
      if (partialSource.trim()) {
        try {
          return babelParse(partialSource, PARSE_OPTIONS);
        } catch {
          // noop — fall through to empty parse
        }
      }
    }

    // Last resort: return empty program
    return babelParse("", { ...PARSE_OPTIONS, sourceType: "script" });
  }
}

/** How much of the input the returned AST represents. */
export type ParseCompleteness = "whole" | "truncated" | "empty";

/** Which parse produced the AST: the primary (module-capable) parse or the sourceType "script" fallback. */
export type ParseMode = "module-capable" | "script-fallback";

/**
 * Structured parse outcome. Decisions about a parse read these fields,
 * never the warning text.
 */
export interface ParseOutcome {
  completeness: ParseCompleteness;
  mode: ParseMode;
  /** Number of errors Babel recovered from in the returned AST. */
  recoveredErrors: number;
  /** Line of the primary syntax error, set whenever the truncation fallback ran. */
  truncatedAtLine?: number;
}

export interface ParseResult extends ParseOutcome {
  ast: File;
  warnings: string[];
}

/** Record Babel error-recovery diagnostics of `ast` as warnings; returns how many there were. */
function collectRecoveredErrors(ast: File, warnings: string[]): number {
  const errors: unknown[] = (ast as any).errors ?? [];
  for (const err of errors as any[]) {
    warnings.push(`Parse error (recovered): ${err.message ?? err}`);
  }
  return errors.length;
}

/**
 * Parse with diagnostics — returns warnings when fallback/truncation occurs.
 * Use this when you need to know if the parse was clean or degraded.
 */
export function parseWithDiagnostics(source: string): ParseResult {
  const warnings: string[] = [];

  try {
    const ast = babelParse(source, PARSE_OPTIONS);
    // Check for Babel error-recovery diagnostics
    const recoveredErrors = collectRecoveredErrors(ast, warnings);
    return { ast, warnings, completeness: "whole", mode: "module-capable", recoveredErrors };
  } catch (e: unknown) {
    // Fallback: try sourceType "script"
    try {
      const ast = babelParse(source, { ...PARSE_OPTIONS, sourceType: "script" });
      warnings.push("Fell back to sourceType 'script' after module parse failure");
      const recoveredErrors = collectRecoveredErrors(ast, warnings);
      return { ast, warnings, completeness: "whole", mode: "script-fallback", recoveredErrors };
    } catch {
      // noop — fall through to truncation
    }

    // Truncation fallback
    let truncatedAtLine: number | undefined;
    if (e instanceof SyntaxError && typeof (e as any).loc?.line === "number") {
      const errorLine: number = (e as any).loc.line;
      truncatedAtLine = errorLine;
      warnings.push(`Truncated at line ${errorLine}: ${(e as Error).message}`);
      const lines = source.split("\n");
      const partialSource = lines.slice(0, errorLine - 1).join("\n");
      if (partialSource.trim()) {
        try {
          const ast = babelParse(partialSource, PARSE_OPTIONS);
          const recoveredErrors = collectRecoveredErrors(ast, warnings);
          return { ast, warnings, completeness: "truncated", mode: "module-capable", recoveredErrors, truncatedAtLine };
        } catch {
          // noop — fall through to empty parse
        }
      }
    }

    // Last resort: empty program (keeps the truncation line when one was determined)
    warnings.push("Could not parse source; returned empty program");
    const ast = babelParse("", { ...PARSE_OPTIONS, sourceType: "script" });
    const recoveredErrors = collectRecoveredErrors(ast, warnings);
    const outcome: ParseResult = { ast, warnings, completeness: "empty", mode: "script-fallback", recoveredErrors };
    if (truncatedAtLine !== undefined) outcome.truncatedAtLine = truncatedAtLine;
    return outcome;
  }
}

export function generate(ast: File): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = babelGenerate(ast as any, {
    comments: true,
    compact: false,
    concise: false,
  });
  return result.code;
}
