/**
 * Babel-based JavaScript parser and code generator.
 * Single parse -> multiple transforms -> single generate.
 */

import { parse as babelParse, generate as babelGenerate } from "./babel.js";
import type { File } from "@babel/types";

export function parse(source: string): File {
  return babelParse(source, {
    sourceType: "unambiguous",
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    plugins: ["dynamicImport", "optionalChaining", "nullishCoalescingOperator"],
  });
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
