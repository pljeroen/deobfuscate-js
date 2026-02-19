/**
 * String array resolution pass.
 *
 * Detects the string array obfuscation pattern produced by javascript-obfuscator:
 * 1. A string array: variable assigned to an array of string literals, OR a
 *    self-overwriting function that returns such an array
 * 2. An optional rotation IIFE: shuffles the array at load time
 * 3. A decoder function: takes numeric index, returns string from the array
 * 4. Optional wrapper functions: forward calls to the decoder with offset arithmetic
 * 5. Optional offset objects: objects with numeric literal values used in call arguments
 *
 * Resolution: extracts setup code (array + rotation + decoder + wrappers + offset objects),
 * executes in a sandboxed child process, collects decoded strings, replaces all
 * decoder/wrapper calls with string literals, removes the setup code.
 */

import { traverse, t } from "../babel.js";
import _generate from "@babel/generator";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";
import { executeSandboxed } from "../sandbox.js";

// Handle CJS interop for generate (same pattern as babel.ts)
const generateNode: typeof _generate = (_generate as any).default ?? _generate;

export const stringArrayPass: ASTPass = {
  name: "string-array",
  description: "Resolve string array obfuscation (decoder functions, rotation, encoding)",
  safety: "unsafe",

  run(ast: File): File {
    const pattern = detectPattern(ast);
    if (!pattern) return ast;

    try {
      const resolved = resolveViaSandbox(pattern);
      if (!resolved || resolved.size === 0) return ast;

      inlineResolvedCalls(ast, pattern, resolved);
      removeSetupStatements(ast, pattern);
    } catch {
      // Sandbox failure (timeout, runtime error) — return AST unchanged
    }

    return ast;
  },
};

interface StringArrayPattern {
  arrayName: string;
  decoderName: string;
  wrapperNames: string[];
  /** All function names whose calls should be inlined (decoder + wrappers) */
  calleeNames: Set<string>;
  /** Indices of statements to remove after resolution (array, rotation, decoder, wrappers) */
  removeIndices: number[];
  /** Generated source code for the sandbox (setup + offset objects) */
  setupCode: string;
  /** Map from "fnName:argsKey" to call source expression */
  uniqueCalls: Map<string, string>;
}

// --- Detection ---

function detectPattern(ast: File): StringArrayPattern | null {
  const body = ast.program.body;

  // Step 1: Find string array — var declaration or self-overwriting function
  let arrayName: string | null = null;
  let arrayIdx = -1;

  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (t.isIdentifier(decl.id) && t.isArrayExpression(decl.init) &&
            isAllStringLiterals(decl.init) && decl.init.elements.length >= 3) {
          arrayName = decl.id.name;
          arrayIdx = i;
          break;
        }
      }
    }
    if (!arrayName && t.isFunctionDeclaration(stmt) && t.isIdentifier(stmt.id) &&
        isSelfOverwritingArrayFn(stmt)) {
      arrayName = stmt.id.name;
      arrayIdx = i;
    }
    if (arrayName) break;
  }
  if (!arrayName || arrayIdx === -1) return null;

  // Step 2: Find decoder — function whose body references arrayName
  let decoderName: string | null = null;
  let decoderIdx = -1;

  for (let i = 0; i < body.length; i++) {
    if (i === arrayIdx) continue;
    const name = getFnName(body[i]);
    if (name && bodyContainsName(body[i], arrayName)) {
      decoderName = name;
      decoderIdx = i;
      break;
    }
  }

  // Fallback: most-called function with numeric first arg (backward compat)
  if (!decoderName) {
    const result = findDecoderByFrequency(ast, arrayIdx);
    if (!result) return null;
    decoderName = result.name;
    decoderIdx = result.idx;
  }
  if (!decoderName || decoderIdx === -1) return null;

  // Step 3: Find wrapper functions — body calls decoderName
  const wrapperNames: string[] = [];
  const wrapperIndices: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (i === arrayIdx || i === decoderIdx) continue;
    const name = getFnName(body[i]);
    if (name && bodyContainsName(body[i], decoderName)) {
      wrapperNames.push(name);
      wrapperIndices.push(i);
    }
  }

  const calleeNames = new Set([decoderName, ...wrapperNames]);

  // Step 4: Collect offset objects — var with object of only numeric values
  const offsetIndices: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (isOffsetObjectDecl(body[i])) {
      offsetIndices.push(i);
    }
  }

  // Step 5: Build removal indices (core setup: array → last setup fn, including IIFEs)
  const lastIdx = Math.max(arrayIdx, decoderIdx, ...wrapperIndices);
  const removeIndices: number[] = [];
  for (let i = Math.min(arrayIdx, decoderIdx); i <= lastIdx; i++) {
    const stmt = body[i];
    if (t.isVariableDeclaration(stmt) || t.isFunctionDeclaration(stmt) || isIIFE(stmt)) {
      removeIndices.push(i);
    }
  }

  // Step 6: Build setup code (core + offset objects for sandbox evaluation)
  const codeIndices = [...new Set([...removeIndices, ...offsetIndices])].sort((a, b) => a - b);
  const setupCode = codeIndices.map(i => generateNode(body[i] as any).code).join("\n");

  // Step 7: Collect unique calls to decoder and wrappers (excluding internal calls)
  const setupFnNames = new Set([arrayName, decoderName, ...wrapperNames]);
  const uniqueCalls = new Map<string, string>();

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !calleeNames.has(callee.name)) return;

      // Skip calls inside setup functions (e.g., wrapper calling decoder internally)
      const parentFn = path.findParent(
        p => t.isFunctionDeclaration(p.node) || t.isFunctionExpression(p.node),
      );
      if (parentFn) {
        const pNode = parentFn.node;
        if (t.isFunctionDeclaration(pNode) && t.isIdentifier(pNode.id) &&
            setupFnNames.has(pNode.id.name)) {
          return;
        }
      }

      const argsKey = path.node.arguments
        .map(a => generateNode(a as any).code)
        .join(",");
      const key = callee.name + ":" + argsKey;
      if (!uniqueCalls.has(key)) {
        uniqueCalls.set(key, generateNode(path.node as any).code);
      }
    },
  });

  if (uniqueCalls.size === 0) return null;

  return {
    arrayName,
    decoderName,
    wrapperNames,
    calleeNames,
    removeIndices,
    setupCode,
    uniqueCalls,
  };
}

// --- Sandbox execution ---

function resolveViaSandbox(pattern: StringArrayPattern): Map<string, string> | null {
  const calls = [...pattern.uniqueCalls.entries()];
  if (calls.length === 0) return null;

  // Wrap each call in try-catch so one failure doesn't block others
  const resultAssignments = calls
    .map(([key, callSource]) =>
      `try { __results[${JSON.stringify(key)}] = ${callSource}; } catch(e) {}`)
    .join("\n");

  const script = `
${pattern.setupCode}
var __results = {};
${resultAssignments}
process.stdout.write(JSON.stringify(__results));
`;

  const output = executeSandboxed(script, 5000);
  const results: Record<string, unknown> = JSON.parse(output);

  const resolved = new Map<string, string>();
  for (const [key, value] of Object.entries(results)) {
    if (typeof value === "string") {
      resolved.set(key, value);
    }
  }

  return resolved.size > 0 ? resolved : null;
}

// --- Inlining ---

function inlineResolvedCalls(
  ast: File,
  pattern: StringArrayPattern,
  resolved: Map<string, string>,
): void {
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !pattern.calleeNames.has(callee.name)) return;

      const argsKey = path.node.arguments
        .map(a => generateNode(a as any).code)
        .join(",");
      const key = callee.name + ":" + argsKey;
      const value = resolved.get(key);
      if (value !== undefined) {
        path.replaceWith(t.stringLiteral(value));
      }
    },
  });
}

// --- Cleanup ---

function removeSetupStatements(ast: File, pattern: StringArrayPattern): void {
  const body = ast.program.body;
  const nodesToRemove = new Set(
    pattern.removeIndices.map(i => body[i]).filter(Boolean),
  );

  traverse(ast, {
    Statement(path) {
      if (nodesToRemove.has(path.node)) {
        path.remove();
      }
    },
  });
}

// --- Helper functions ---

function isSelfOverwritingArrayFn(stmt: t.FunctionDeclaration): boolean {
  if (!stmt.id) return false;
  const fnName = stmt.id.name;
  const stmts = stmt.body.body;
  let hasStringArray = false;
  let hasSelfAssign = false;

  for (const s of stmts) {
    if (t.isVariableDeclaration(s)) {
      for (const d of s.declarations) {
        if (t.isArrayExpression(d.init) && isAllStringLiterals(d.init) &&
            d.init.elements.length >= 3) {
          hasStringArray = true;
        }
      }
    }
    if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) &&
        t.isIdentifier(s.expression.left) && s.expression.left.name === fnName) {
      hasSelfAssign = true;
    }
  }
  return hasStringArray && hasSelfAssign;
}

function getFnName(stmt: t.Statement): string | null {
  if (t.isFunctionDeclaration(stmt) && t.isIdentifier(stmt.id)) {
    return stmt.id.name;
  }
  if (t.isVariableDeclaration(stmt)) {
    for (const d of stmt.declarations) {
      if (t.isIdentifier(d.id) &&
          (t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init))) {
        return d.id.name;
      }
    }
  }
  return null;
}

function bodyContainsName(stmt: t.Statement, name: string): boolean {
  let body: t.Node | undefined;
  if (t.isFunctionDeclaration(stmt)) {
    body = stmt.body;
  } else if (t.isVariableDeclaration(stmt)) {
    for (const d of stmt.declarations) {
      if ((t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init)) &&
          t.isBlockStatement(d.init.body)) {
        body = d.init.body;
      }
    }
  }
  if (!body) return false;
  return generateNode(body as any).code.includes(name);
}

function isOffsetObjectDecl(stmt: t.Statement): boolean {
  if (!t.isVariableDeclaration(stmt)) return false;
  for (const d of stmt.declarations) {
    if (!t.isIdentifier(d.id) || !t.isObjectExpression(d.init)) continue;
    if (d.init.properties.length === 0) continue;
    const allNumeric = d.init.properties.every(p => {
      if (!t.isObjectProperty(p)) return false;
      return t.isNumericLiteral(p.value) ||
        (t.isUnaryExpression(p.value) && t.isNumericLiteral(p.value.argument));
    });
    if (allNumeric) return true;
  }
  return false;
}

function isIIFE(stmt: t.Statement): boolean {
  if (!t.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  if (!t.isCallExpression(expr)) return false;
  const callee = expr.callee;
  return t.isFunctionExpression(callee) ||
    (t.isParenthesizedExpression(callee) &&
     t.isFunctionExpression((callee as t.ParenthesizedExpression).expression));
}

function isAllStringLiterals(arr: t.ArrayExpression): boolean {
  return arr.elements.length > 0 && arr.elements.every(
    el => el !== null && t.isStringLiteral(el),
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

function findDecoderByFrequency(
  ast: File,
  arrayIdx: number,
): { name: string; idx: number } | null {
  const body = ast.program.body;
  const callCounts = new Map<string, number>();

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      if (path.node.arguments.length === 0 ||
          !t.isNumericLiteral(path.node.arguments[0])) return;
      callCounts.set(callee.name, (callCounts.get(callee.name) || 0) + 1);
    },
  });

  let bestName: string | null = null;
  let bestCount = 0;
  for (const [name, count] of callCounts) {
    if (count >= 2 && count > bestCount && !isBuiltinFunction(name)) {
      bestName = name;
      bestCount = count;
    }
  }
  if (!bestName) return null;

  for (let i = 0; i < body.length; i++) {
    if (i === arrayIdx) continue;
    if (getFnName(body[i]) === bestName) {
      return { name: bestName, idx: i };
    }
  }
  return null;
}
