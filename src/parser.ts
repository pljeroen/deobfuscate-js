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

export interface ParseResult {
  ast: File;
  warnings: string[];
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
    if ((ast as any).errors?.length > 0) {
      for (const err of (ast as any).errors) {
        warnings.push(`Parse error (recovered): ${err.message ?? err}`);
      }
    }
    return { ast, warnings };
  } catch (e: unknown) {
    // Fallback: try sourceType "script"
    try {
      const ast = babelParse(source, { ...PARSE_OPTIONS, sourceType: "script" });
      warnings.push("Fell back to sourceType 'script' after module parse failure");
      return { ast, warnings };
    } catch {
      // noop — fall through to truncation
    }

    // Truncation fallback
    if (e instanceof SyntaxError && typeof (e as any).loc?.line === "number") {
      const errorLine: number = (e as any).loc.line;
      warnings.push(`Truncated at line ${errorLine}: ${(e as Error).message}`);
      const lines = source.split("\n");
      const partialSource = lines.slice(0, errorLine - 1).join("\n");
      if (partialSource.trim()) {
        try {
          return { ast: babelParse(partialSource, PARSE_OPTIONS), warnings };
        } catch {
          // noop — fall through to empty parse
        }
      }
    }

    // Last resort: empty program
    warnings.push("Could not parse source; returned empty program");
    return { ast: babelParse("", { ...PARSE_OPTIONS, sourceType: "script" }), warnings };
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
