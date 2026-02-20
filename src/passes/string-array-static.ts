/**
 * Static string array recovery — safe mode fallback.
 *
 * Resolves string array obfuscation WITHOUT code execution by:
 * 1. Detecting unencoded string arrays (direct index lookup)
 * 2. Detecting base64-encoded string arrays (known-plaintext matching)
 * 3. Handling numeric offsets in decoder functions
 *
 * This pass is safe — it only analyzes the AST, never executes code.
 * Acts as fallback when the unsafe string-array pass is disabled.
 */

import { traverse, t } from "../babel.js";
import type { File, Statement } from "@babel/types";
import type { ASTPass } from "../types.js";

const HEX_PREFIX = /^_0x/;

/** Common JS property/method names likely to appear in obfuscated code. */
const KNOWN_STRINGS = [
  "prototype", "constructor", "length", "toString", "valueOf",
  "hasOwnProperty", "apply", "call", "bind", "undefined",
  "return", "function", "object", "string", "number",
  "boolean", "while", "for", "if", "else",
  "push", "pop", "shift", "unshift", "splice",
  "slice", "concat", "join", "indexOf", "forEach",
  "map", "filter", "reduce", "keys", "values",
  "log", "warn", "error", "info", "debug",
  "document", "window", "console", "exports", "module",
  "require", "default", "name", "value", "type",
];

/** Pre-compute base64 encodings of known strings. */
const BASE64_TO_PLAIN = new Map<string, string>();
for (const s of KNOWN_STRINGS) {
  BASE64_TO_PLAIN.set(Buffer.from(s).toString("base64"), s);
}

interface StaticPattern {
  arrayName: string;
  arrayIndex: number;
  decoderName: string;
  decoderIndex: number;
  elements: string[];
  offset: number;
  encoding: "none" | "base64";
}

export const stringArrayStaticPass: ASTPass = {
  name: "string-array-static",
  description: "Resolve string array obfuscation via static analysis (no code execution)",

  run(ast: File, source?: string): File {
    const pattern = detectStaticPattern(ast);
    if (!pattern) return ast;

    const decoded = decodeElements(pattern);
    if (!decoded) return ast;

    // Inline decoder calls
    traverse(ast, {
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee)) return;
        if (path.node.callee.name !== pattern.decoderName) return;
        if (path.node.arguments.length < 1) return;

        const arg = path.node.arguments[0];
        if (!t.isNumericLiteral(arg)) return;

        const idx = arg.value - pattern.offset;
        if (idx >= 0 && idx < decoded.length) {
          path.replaceWith(t.stringLiteral(decoded[idx]));
        }
      },
    });

    // Remove setup code (array declaration + decoder function)
    removeSetup(ast, pattern);

    return ast;
  },
};

function detectStaticPattern(ast: File): StaticPattern | null {
  const body = ast.program.body;

  // Find string array: var _0x... = ["...", "...", ...]
  let arrayName: string | null = null;
  let arrayIndex = -1;
  let elements: string[] = [];

  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id) || !HEX_PREFIX.test(decl.id.name)) continue;
      if (!t.isArrayExpression(decl.init)) continue;
      const elems = decl.init.elements;
      if (elems.length < 3) continue;
      if (!elems.every(el => t.isStringLiteral(el))) continue;

      arrayName = decl.id.name;
      arrayIndex = i;
      elements = (elems as t.StringLiteral[]).map(el => el.value);
      break;
    }
    if (arrayName) break;
  }

  if (!arrayName) return null;

  // Find decoder function: function _0x...(idx) { return _0xarray[idx] }
  // or with offset: return _0xarray[idx - offset]
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (!t.isFunctionDeclaration(stmt)) continue;
    if (!stmt.id || !HEX_PREFIX.test(stmt.id.name)) continue;
    if (stmt.params.length < 1) continue;

    const fbody = stmt.body.body;
    if (fbody.length !== 1 || !t.isReturnStatement(fbody[0])) continue;

    const ret = fbody[0].argument;
    if (!ret) continue;

    // Pattern: _0xarray[param] or _0xarray[param - offset]
    if (t.isMemberExpression(ret) && ret.computed) {
      if (!t.isIdentifier(ret.object) || ret.object.name !== arrayName) continue;

      const paramName = t.isIdentifier(stmt.params[0]) ? stmt.params[0].name : null;
      if (!paramName) continue;

      let offset = 0;
      const prop = ret.property;

      if (t.isIdentifier(prop) && prop.name === paramName) {
        // Direct: return arr[idx]
        offset = 0;
      } else if (
        t.isBinaryExpression(prop) &&
        prop.operator === "-" &&
        t.isIdentifier(prop.left) &&
        prop.left.name === paramName &&
        t.isNumericLiteral(prop.right)
      ) {
        // Offset: return arr[idx - 100]
        offset = prop.right.value;
      } else {
        continue;
      }

      // Detect encoding
      const encoding = detectEncoding(elements);

      return {
        arrayName,
        arrayIndex,
        decoderName: stmt.id.name,
        decoderIndex: i,
        elements,
        offset,
        encoding,
      };
    }
  }

  return null;
}

/** Detect if elements are base64-encoded by checking against known strings. */
function detectEncoding(elements: string[]): "none" | "base64" {
  let base64Matches = 0;
  for (const el of elements) {
    if (BASE64_TO_PLAIN.has(el)) {
      base64Matches++;
    }
  }
  // If >=2 elements match known base64 strings, it's likely base64-encoded
  if (base64Matches >= 2) return "base64";
  return "none";
}

/** Decode elements based on detected encoding. */
function decodeElements(pattern: StaticPattern): string[] | null {
  if (pattern.encoding === "none") {
    return pattern.elements;
  }

  if (pattern.encoding === "base64") {
    try {
      return pattern.elements.map(el => Buffer.from(el, "base64").toString("utf-8"));
    } catch {
      return null;
    }
  }

  return null;
}

/** Remove the string array declaration and decoder function from the AST. */
function removeSetup(ast: File, pattern: StaticPattern): void {
  const indicesToRemove = new Set([pattern.arrayIndex, pattern.decoderIndex]);

  // Remove in reverse order to preserve indices
  const sorted = [...indicesToRemove].sort((a, b) => b - a);
  for (const idx of sorted) {
    if (idx >= 0 && idx < ast.program.body.length) {
      ast.program.body.splice(idx, 1);
    }
  }
}
