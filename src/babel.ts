/**
 * Re-exports Babel modules with correct ESM/CJS interop handling.
 */

import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

// Handle CJS interop: the "default" may be nested under .default in ESM
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const generate: typeof _generate = (_generate as any).default ?? _generate;

export { parse } from "@babel/parser";
export * as t from "@babel/types";
