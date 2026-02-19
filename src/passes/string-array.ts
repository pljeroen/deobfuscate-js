/**
 * String array resolution pass.
 *
 * Detects the string array obfuscation pattern produced by javascript-obfuscator:
 * 1. A string array: variable assigned to an array of string literals
 * 2. An optional rotation IIFE: shuffles the array at load time
 * 3. A decoder function: takes numeric index, returns string from the array
 *
 * Resolution: extracts setup code (array + rotation + decoder), executes in a
 * sandboxed child process, collects decoded strings, replaces all decoder calls
 * with string literals, removes the setup code.
 */

import { traverse, t } from "../babel.js";
import _generate from "@babel/generator";
import type { File } from "@babel/types";
import type { NodePath } from "@babel/traverse";
import type { ASTPass } from "../types.js";
import { executeSandboxed } from "../sandbox.js";

// Handle CJS interop for generate (same pattern as babel.ts)
const generateNode: typeof _generate = (_generate as any).default ?? _generate;

export const stringArrayPass: ASTPass = {
  name: "string-array",
  description: "Resolve string array obfuscation (decoder functions, rotation, encoding)",

  run(ast: File): File {
    const pattern = detectPattern(ast);
    if (!pattern) return ast;

    try {
      const resolved = resolveViasSandbox(pattern);
      if (!resolved || resolved.size === 0) return ast;

      inlineResolvedCalls(ast, pattern.decoderName, resolved);
      removeSetupStatements(ast, pattern);
    } catch {
      // Sandbox failure (timeout, runtime error) — return AST unchanged
    }

    return ast;
  },
};

interface StringArrayPattern {
  /** Name of the string array variable */
  arrayName: string;
  /** Name of the decoder function */
  decoderName: string;
  /** Indices of top-level statements that form the setup (array, rotation, decoder) */
  setupStatementIndices: number[];
  /** Generated source code for the setup region */
  setupCode: string;
  /** All unique decoder call expressions as source strings, mapped to their argument signatures */
  uniqueCalls: Map<string, string>;
}

/**
 * Detect the string array pattern in the AST.
 * Returns null if the pattern is not found.
 */
function detectPattern(ast: File): StringArrayPattern | null {
  const program = ast.program;
  const body = program.body;

  // Step 1: Find candidate decoder functions — called ≥2 times with numeric literal first arg
  const callInfo = new Map<string, { numericCount: number; callSources: Map<string, string> }>();

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      const name = callee.name;

      if (!callInfo.has(name)) {
        callInfo.set(name, { numericCount: 0, callSources: new Map() });
      }
      const info = callInfo.get(name)!;

      // Only track calls with numeric literal first argument (skip recursive/internal calls)
      if (path.node.arguments.length === 0 || !t.isNumericLiteral(path.node.arguments[0])) return;

      info.numericCount++;

      // Generate a unique key for this call (based on all arguments)
      const argsKey = path.node.arguments
        .map(a => generateNode(a as any).code)
        .join(",");
      const callSource = generateNode(path.node as any).code;
      info.callSources.set(argsKey, callSource);
    },
  });

  // Filter to functions called ≥2 times with numeric first args
  let decoderName: string | null = null;
  let maxCalls = 0;
  for (const [name, info] of callInfo) {
    if (info.numericCount >= 2 && info.numericCount > maxCalls) {
      // Verify this isn't a built-in
      if (isBuiltinFunction(name)) continue;
      decoderName = name;
      maxCalls = info.numericCount;
    }
  }
  if (!decoderName) return null;

  const decoderInfo = callInfo.get(decoderName)!;

  // Step 2: Find the string array — an ArrayExpression of all StringLiterals
  let arrayName: string | null = null;
  let arrayStatementIdx = -1;

  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (!t.isIdentifier(decl.id)) continue;
        if (t.isArrayExpression(decl.init) && isAllStringLiterals(decl.init) && decl.init.elements.length >= 3) {
          arrayName = decl.id.name;
          arrayStatementIdx = i;
          break;
        }
      }
    }
    if (arrayName) break;
  }
  if (!arrayName || arrayStatementIdx === -1) return null;

  // Step 3: Find the decoder function declaration index
  let decoderStatementIdx = -1;
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (t.isFunctionDeclaration(stmt) && t.isIdentifier(stmt.id) && stmt.id.name === decoderName) {
      decoderStatementIdx = i;
      break;
    }
    // Also handle: var _0xdec = function(...) { ... }
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (t.isIdentifier(decl.id) && decl.id.name === decoderName &&
            (t.isFunctionExpression(decl.init) || t.isArrowFunctionExpression(decl.init))) {
          decoderStatementIdx = i;
          break;
        }
      }
    }
    if (decoderStatementIdx !== -1) break;
  }
  if (decoderStatementIdx === -1) return null;

  // Step 4: Collect all setup statement indices (from array to decoder, inclusive)
  // Include everything between array and decoder: may contain rotation IIFE
  const setupStatementIndices: number[] = [];
  const startIdx = Math.min(arrayStatementIdx, decoderStatementIdx);
  const endIdx = Math.max(arrayStatementIdx, decoderStatementIdx);

  for (let i = startIdx; i <= endIdx; i++) {
    const stmt = body[i];
    // Include variable declarations, function declarations, and IIFEs
    if (t.isVariableDeclaration(stmt) || t.isFunctionDeclaration(stmt)) {
      setupStatementIndices.push(i);
    } else if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression) &&
               (t.isFunctionExpression(stmt.expression.callee) ||
                (t.isParenthesizedExpression(stmt.expression.callee) &&
                 t.isFunctionExpression((stmt.expression.callee as t.ParenthesizedExpression).expression)))) {
      // IIFE — likely rotation
      setupStatementIndices.push(i);
    }
  }

  // Step 5: Generate setup code from the included statements
  const setupCode = setupStatementIndices
    .map(i => generateNode(body[i] as any).code)
    .join("\n");

  return {
    arrayName,
    decoderName,
    setupStatementIndices,
    setupCode,
    uniqueCalls: decoderInfo.callSources,
  };
}

/**
 * Execute the setup code + decoder calls in a sandboxed child process.
 * Returns a map from call source → resolved string value.
 */
function resolveViasSandbox(pattern: StringArrayPattern): Map<string, string> | null {
  const calls = [...pattern.uniqueCalls.entries()];
  if (calls.length === 0) return null;

  // Build sandbox script
  const resultAssignments = calls
    .map(([key, callSource], i) => `__results[${JSON.stringify(key)}] = ${callSource};`)
    .join("\n");

  const script = `
${pattern.setupCode}
var __results = {};
${resultAssignments}
process.stdout.write(JSON.stringify(__results));
`;

  const output = executeSandboxed(script, 5000);
  const results: Record<string, unknown> = JSON.parse(output);

  // Validate all results are strings
  const resolved = new Map<string, string>();
  for (const [key, value] of Object.entries(results)) {
    if (typeof value === "string") {
      resolved.set(key, value);
    }
  }

  return resolved.size > 0 ? resolved : null;
}

/**
 * Replace all decoder call expressions with their resolved string literals.
 */
function inlineResolvedCalls(ast: File, decoderName: string, resolved: Map<string, string>): void {
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || callee.name !== decoderName) return;

      const argsKey = path.node.arguments
        .map(a => generateNode(a as any).code)
        .join(",");

      const value = resolved.get(argsKey);
      if (value !== undefined) {
        path.replaceWith(t.stringLiteral(value));
      }
    },
  });
}

/**
 * Remove the setup statements (string array, rotation IIFE, decoder function)
 * from the program body.
 */
function removeSetupStatements(ast: File, pattern: StringArrayPattern): void {
  const toRemove = new Set(pattern.setupStatementIndices);

  // Traverse and remove by matching the exact statement nodes
  const body = ast.program.body;
  const nodesToRemove = new Set(
    pattern.setupStatementIndices.map(i => body[i]).filter(Boolean)
  );

  traverse(ast, {
    Statement(path) {
      if (nodesToRemove.has(path.node)) {
        path.remove();
      }
    },
  });
}

function isAllStringLiterals(arr: t.ArrayExpression): boolean {
  return arr.elements.length > 0 && arr.elements.every(
    el => el !== null && t.isStringLiteral(el)
  );
}

function isBuiltinFunction(name: string): boolean {
  const builtins = new Set([
    "parseInt", "parseFloat", "isNaN", "isFinite",
    "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
    "eval", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "require", "define",
  ]);
  return builtins.has(name);
}
