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

  run(ast: File, source?: string): File {
    const pattern = detectPattern(ast, source);
    if (!pattern) return ast;

    try {
      const resolved = resolveViaSandbox(pattern);
      if (!resolved || resolved.size === 0) return ast;

      inlineResolvedCalls(ast, pattern, resolved);
      removeSetupStatements(ast, pattern);
    } catch {
      // Sandbox execution failed (timeout, syntax error, etc.) — skip this pass
    }

    return ast;
  },
};

interface StringArrayPattern {
  arrayName: string;
  decoderNames: string[];
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

/** Extract original source text for a node, preserving exact formatting. */
function sourceSlice(node: t.Node, source: string | undefined): string | null {
  if (!source || node.start == null || node.end == null) return null;
  return source.substring(node.start, node.end);
}

/** Generate code for a node, preferring original source to preserve formatting. */
function nodeCode(node: t.Node, source: string | undefined): string {
  return sourceSlice(node, source) ?? generateNode(node as any).code;
}

function detectPattern(ast: File, source?: string): StringArrayPattern | null {
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

  // Step 2: Find decoders — functions whose body references arrayName
  // (obfuscator.io can generate multiple decoders with different encodings)
  const decoderNames: string[] = [];
  const decoderIndices: number[] = [];

  for (let i = 0; i < body.length; i++) {
    if (i === arrayIdx) continue;
    const name = getFnName(body[i]);
    if (name && bodyContainsName(body[i], arrayName)) {
      decoderNames.push(name);
      decoderIndices.push(i);
    }
  }

  // Fallback: most-called function with numeric first arg (backward compat)
  if (decoderNames.length === 0) {
    const result = findDecoderByFrequency(ast, arrayIdx);
    if (!result) return null;
    decoderNames.push(result.name);
    decoderIndices.push(result.idx);
  }
  if (decoderNames.length === 0) return null;

  // Step 3: Find wrapper functions — small forwarding functions that call a decoder
  // Wrappers have exactly 2 params, a short body (≤3 statements), and call a decoder.
  // This distinguishes them from user functions that happen to use the decoder.
  const wrapperNames: string[] = [];
  const wrapperIndices: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (i === arrayIdx || decoderIndices.includes(i)) continue;
    const name = getFnName(body[i]);
    if (name && decoderNames.some(dn => isWrapperFunction(body[i], dn))) {
      wrapperNames.push(name);
      wrapperIndices.push(i);
    }
  }

  const calleeNames = new Set([...decoderNames, ...wrapperNames]);

  // Step 4: Collect offset objects — var with object of only numeric values
  const offsetIndices: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (isOffsetObjectDecl(body[i])) {
      offsetIndices.push(i);
    }
  }

  // Step 5: Build removal indices (before scoped wrapper detection, so we can skip setup-internal)
  const removeIndices: number[] = [arrayIdx, ...decoderIndices, ...wrapperIndices];

  // Find rotation IIFEs — IIFEs whose arguments reference the array name
  for (let i = 0; i < body.length; i++) {
    if (removeIndices.includes(i)) continue;
    if (isIIFE(body[i]) && new RegExp(`\\b${arrayName}\\b`).test(nodeCode(body[i], source))) {
      removeIndices.push(i);
    }
  }

  const setupStmtNodes = new Set(removeIndices.map(i => body[i]).filter(Boolean));

  // Step 3b: Find function-scoped wrappers — nested wrappers that call known callees
  // Iterate until convergence to handle wrapper chains (A calls B calls decoder).
  const scopedWrapperDefs: string[] = [];
  const scopedContextDefs: string[] = [];
  const extractedContextNames = new Set<string>();

  let prevCalleeSize: number;
  do {
    prevCalleeSize = calleeNames.size;
    traverse(ast, {
      FunctionDeclaration(path) {
        const node = path.node;
        if (!t.isIdentifier(node.id)) return;
        const name = node.id.name;
        if (calleeNames.has(name) || name === arrayName) return;

        // Must be nested (inside another function)
        const parentFn = path.findParent(
          p => t.isFunctionDeclaration(p.node) || t.isFunctionExpression(p.node),
        );
        if (!parentFn) return;

        // Skip wrappers inside setup statements (rotation IIFEs, decoder bodies)
        const topStmt = path.findParent(p => p.parentPath?.node === ast.program);
        if (topStmt && setupStmtNodes.has(topStmt.node as t.Statement)) return;

        // Must match wrapper pattern: ≥2 params, short body
        if (node.params.length < 2) return;
        if (node.body.body.length > 3) return;

        // Body must call a known callee (decoder, top-level wrapper, or already-detected scoped wrapper)
        const bodyCode = generateNode(node.body as any).code;
        const paramNames = new Set(
          node.params.filter(p => t.isIdentifier(p)).map(p => (p as t.Identifier).name),
        );
        const callsKnown = [...calleeNames].some(
          cn => !paramNames.has(cn) && new RegExp(`\\b${cn}\\b`).test(bodyCode),
        );
        if (!callsKnown) return;

        // Found a scoped wrapper
        calleeNames.add(name);
        scopedWrapperDefs.push(generateNode(node as any).code);

        // Extract referenced variables from enclosing scope (offset objects)
        const parentFnNode = parentFn.node as t.FunctionDeclaration | t.FunctionExpression;
        for (const stmt of parentFnNode.body.body) {
          if (!t.isVariableDeclaration(stmt)) continue;
          for (const d of stmt.declarations) {
            if (!t.isIdentifier(d.id)) continue;
            if (extractedContextNames.has(d.id.name)) continue;
            if (new RegExp(`\\b${d.id.name}\\b`).test(bodyCode)) {
              extractedContextNames.add(d.id.name);
              scopedContextDefs.push(generateNode(stmt as any).code);
            }
          }
        }
      },
    });
  } while (calleeNames.size > prevCalleeSize);

  // Step 3c: Find variable aliases — `var x = decoder` creates a local alias for calls
  // (obfuscator.io "calls transform" aliases decoders inside user functions)
  // Skip aliases inside setup statements.
  const aliasDefs: string[] = [];

  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !t.isIdentifier(path.node.init)) return;
      const aliasName = path.node.id.name;
      const targetName = path.node.init.name;
      if (calleeNames.has(aliasName) || !calleeNames.has(targetName)) return;

      // Must be inside a function (top-level aliases are handled by the main flow)
      const parentFn = path.findParent(
        p => t.isFunctionDeclaration(p.node) || t.isFunctionExpression(p.node),
      );
      if (!parentFn) return;

      // Skip aliases inside setup statements
      const topStmt = path.findParent(p => p.parentPath?.node === ast.program);
      if (topStmt && setupStmtNodes.has(topStmt.node as t.Statement)) return;

      calleeNames.add(aliasName);
      aliasDefs.push(`var ${aliasName} = ${targetName};`);
    },
  });

  // Step 6: Build setup code (core + offset objects + scoped wrapper defs for sandbox)
  // Uses original source text when available to preserve exact formatting (critical for
  // self-defending code that checks Function.prototype.toString() output).
  const codeIndices = [...new Set([...removeIndices, ...offsetIndices])].sort((a, b) => a - b);
  let setupCode = codeIndices.map(i => {
    const stmt = body[i];
    // For SequenceExpressions (rotation IIFE + anti-tamper IIFE combined),
    // extract only the IIFEs that reference the array to avoid executing anti-tamper code.
    if (t.isExpressionStatement(stmt) && t.isSequenceExpression(stmt.expression)) {
      const relevant = stmt.expression.expressions.filter(expr => {
        if (!isIIFECall(expr)) return false;
        return new RegExp(`\\b${arrayName}\\b`).test(nodeCode(expr, source));
      });
      if (relevant.length > 0) {
        return relevant.map(e => "(" + nodeCode(e, source) + ");").join("\n");
      }
    }
    return nodeCode(stmt, source);
  }).join("\n");
  if (scopedContextDefs.length > 0) setupCode += "\n" + scopedContextDefs.join("\n");
  if (scopedWrapperDefs.length > 0) setupCode += "\n" + scopedWrapperDefs.join("\n");
  if (aliasDefs.length > 0) setupCode += "\n" + aliasDefs.join("\n");

  // Step 7: Collect unique calls to decoder and wrappers (excluding internal calls)
  const setupFnNames = new Set([arrayName, ...calleeNames]);
  const uniqueCalls = new Map<string, string>();

  // Pre-compute set of nodes for setup statements (for fast exclusion)
  const setupNodes = new Set(removeIndices.map(i => body[i]).filter(Boolean));

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !calleeNames.has(callee.name)) return;

      // Skip calls inside setup statements (rotation IIFEs, decoder/wrapper bodies)
      const topStmt = path.findParent(p => p.parentPath?.node === ast.program);
      if (topStmt && setupNodes.has(topStmt.node as t.Statement)) return;

      // Skip calls inside named setup functions (scoped wrappers calling decoder)
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
    decoderNames,
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

  // Scale timeout with setup complexity + number of calls (RC4 decoding can be slow)
  const setupKB = Math.ceil(pattern.setupCode.length / 1024);
  const timeout = Math.max(5000, Math.min(60000, setupKB * 1000 + calls.length * 50));
  const output = executeSandboxed(script, timeout);
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

/**
 * Check if a statement is a wrapper function — a small forwarding function
 * that calls the decoder with offset arithmetic. Wrappers have:
 * - At least 2 parameters (obfuscator.io may add decoy params)
 * - A short body (≤3 statements: optional var decl + return decoder(...))
 * - A call to decoderName in the body
 * This prevents false positives on user functions that happen to call the decoder.
 */
function isWrapperFunction(stmt: t.Statement, decoderName: string): boolean {
  let params: t.Node[] | undefined;
  let fnBody: t.BlockStatement | undefined;

  if (t.isFunctionDeclaration(stmt)) {
    params = stmt.params;
    fnBody = stmt.body;
  } else if (t.isVariableDeclaration(stmt)) {
    for (const d of stmt.declarations) {
      if (t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init)) {
        params = d.init.params;
        if (t.isBlockStatement(d.init.body)) fnBody = d.init.body;
      }
    }
  }

  if (!params || !fnBody) return false;
  if (params.length < 2) return false;
  if (fnBody.body.length > 3) return false;

  // Body must contain a call to decoderName
  const code = generateNode(fnBody as any).code;
  const re = new RegExp(`\\b${decoderName}\\b`);
  return re.test(code);
}

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
  const code = generateNode(body as any).code;
  const re = new RegExp(`\\b${name}\\b`);
  return re.test(code);
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

function isIIFECall(expr: t.Expression): boolean {
  if (!t.isCallExpression(expr)) return false;
  const callee = expr.callee;
  return t.isFunctionExpression(callee) ||
    (t.isParenthesizedExpression(callee) &&
     t.isFunctionExpression((callee as t.ParenthesizedExpression).expression));
}

function isIIFE(stmt: t.Statement): boolean {
  if (!t.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  // Direct IIFE: (function(...){...})(...)
  if (isIIFECall(expr)) return true;
  // Sequence IIFE: (function(...){...})(...), (function(...){...})(...)
  if (t.isSequenceExpression(expr)) {
    return expr.expressions.some(e => isIIFECall(e));
  }
  // Unary IIFE: !function(...){...}(...)
  if (t.isUnaryExpression(expr) && t.isCallExpression(expr.argument)) {
    return t.isFunctionExpression(expr.argument.callee);
  }
  return false;
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
