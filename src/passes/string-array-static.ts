/**
 * Static string array recovery — safe mode fallback.
 *
 * Resolves string array obfuscation WITHOUT code execution by:
 * 1. Detecting string arrays (var declaration or self-overwriting provider function)
 * 2. Detecting decoder functions (simple return, offset-adjusted, or self-overwriting)
 * 3. Tracking decoder aliases (top-level and function-scoped)
 * 4. Handling numeric offsets and base64 encoding
 *
 * Safety: only analyzes AST, never executes code.
 * Guards: bails out when IIFE passes array source as argument (rotation risk).
 */

import { traverse, t } from "../babel.js";
import type { File, Statement } from "@babel/types";
import type { ASTPass } from "../types.js";

const OBF_PREFIX = /^(?:a\d+_)?_?0x/;

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

const BASE64_TO_PLAIN = new Map<string, string>();
for (const s of KNOWN_STRINGS) {
  BASE64_TO_PLAIN.set(Buffer.from(s).toString("base64"), s);
}

interface ArraySource {
  name: string;
  index: number;
  elements: string[];
}

interface DecoderInfo {
  name: string;
  index: number;
  offset: number;
}

interface AliasInfo {
  name: string;
  topLevelIndex: number | null;
}

interface StaticPattern {
  arraySource: ArraySource;
  decoder: DecoderInfo;
  encoding: "none" | "base64";
  aliases: AliasInfo[];
}

export const stringArrayStaticPass: ASTPass = {
  name: "string-array-static",
  description: "Resolve string array obfuscation via static analysis (no code execution)",

  run(ast: File, source?: string): File {
    const pattern = detectStaticPattern(ast);
    if (!pattern) return ast;

    const decoded = decodeElements(pattern.arraySource.elements, pattern.encoding);
    if (!decoded) return ast;

    const resolverNames = new Set([pattern.decoder.name]);
    for (const alias of pattern.aliases) {
      resolverNames.add(alias.name);
    }

    // Inline decoder and alias calls
    traverse(ast, {
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee)) return;
        if (!resolverNames.has(path.node.callee.name)) return;
        if (path.node.arguments.length < 1) return;

        const arg = path.node.arguments[0];
        if (!t.isNumericLiteral(arg)) return;

        const idx = arg.value - pattern.decoder.offset;
        if (idx >= 0 && idx < decoded.length) {
          path.replaceWith(t.stringLiteral(decoded[idx]));
        }
      },
    });

    // Remove function-scoped alias declarations
    const scopedAliasNames = new Set(
      pattern.aliases.filter(a => a.topLevelIndex === null).map(a => a.name),
    );
    if (scopedAliasNames.size > 0) {
      traverse(ast, {
        VariableDeclarator(path) {
          if (!t.isIdentifier(path.node.id)) return;
          if (!scopedAliasNames.has(path.node.id.name)) return;
          if (!t.isIdentifier(path.node.init)) return;
          if (path.node.init.name !== pattern.decoder.name) return;
          const declPath = path.parentPath;
          if (t.isVariableDeclaration(declPath.node) && declPath.node.declarations.length === 1) {
            declPath.remove();
          } else {
            path.remove();
          }
        },
      });
    }

    // Remove top-level setup (array source, decoder, top-level aliases)
    removeSetup(ast, pattern);

    return ast;
  },
};

// --- Detection ---

function detectStaticPattern(ast: File): StaticPattern | null {
  const body = ast.program.body;

  const arraySource = findVarArray(body) ?? findSelfOverwritingProvider(body);
  if (!arraySource) return null;

  if (hasRotationIIFE(body, arraySource.name)) return null;

  const decoder = findDecoder(body, arraySource);
  if (!decoder) return null;

  const aliases = findAliases(ast, decoder.name);

  return {
    arraySource,
    decoder,
    encoding: detectEncoding(arraySource.elements),
    aliases,
  };
}

/** Find `var _0x... = ["...", "...", ...]` at top level. */
function findVarArray(body: Statement[]): ArraySource | null {
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id) || !OBF_PREFIX.test(decl.id.name)) continue;
      if (!t.isArrayExpression(decl.init)) continue;
      const elems = decl.init.elements;
      if (elems.length < 3) continue;
      if (!elems.every(el => t.isStringLiteral(el))) continue;
      return {
        name: decl.id.name,
        index: i,
        elements: (elems as t.StringLiteral[]).map(el => el.value),
      };
    }
  }
  return null;
}

/** Find self-overwriting array provider: `function _0x() { var a=[...]; _0x=function(){return a}; return _0x(); }` */
function findSelfOverwritingProvider(body: Statement[]): ArraySource | null {
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (!t.isFunctionDeclaration(stmt)) continue;
    if (!stmt.id || !OBF_PREFIX.test(stmt.id.name)) continue;

    const funcName = stmt.id.name;
    const fbody = stmt.body.body;
    if (fbody.length < 2 || fbody.length > 4) continue;

    // Find local var with string array
    let localName: string | null = null;
    let elements: string[] = [];
    for (const s of fbody) {
      if (!t.isVariableDeclaration(s)) continue;
      for (const d of s.declarations) {
        if (!t.isIdentifier(d.id)) continue;
        if (!t.isArrayExpression(d.init)) continue;
        const elems = d.init.elements;
        if (elems.length < 1) continue;
        if (!elems.every(e => t.isStringLiteral(e))) continue;
        localName = d.id.name;
        elements = (elems as t.StringLiteral[]).map(e => e.value);
        break;
      }
      if (localName) break;
    }
    if (!localName || elements.length === 0) continue;

    // Verify self-overwrite: funcName = function() { return localName; }
    const hasSelfOverwrite = fbody.some(s => {
      if (!t.isExpressionStatement(s)) return false;
      const expr = s.expression;
      if (!t.isAssignmentExpression(expr)) return false;
      if (!t.isIdentifier(expr.left) || expr.left.name !== funcName) return false;
      if (!t.isFunctionExpression(expr.right)) return false;
      const inner = expr.right.body.body;
      if (inner.length !== 1 || !t.isReturnStatement(inner[0])) return false;
      const ret = inner[0].argument;
      return t.isIdentifier(ret) && ret.name === localName;
    });
    if (!hasSelfOverwrite) continue;

    return { name: funcName, index: i, elements };
  }
  return null;
}

function findDecoder(body: Statement[], arraySource: ArraySource): DecoderInfo | null {
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (!t.isFunctionDeclaration(stmt)) continue;
    if (!stmt.id || !OBF_PREFIX.test(stmt.id.name)) continue;
    if (stmt.params.length < 1) continue;
    if (stmt.id.name === arraySource.name) continue;

    const funcName = stmt.id.name;
    const fbody = stmt.body.body;

    const simple = trySimpleDecoder(fbody, stmt, arraySource);
    if (simple !== null) return { name: funcName, index: i, offset: simple };

    const selfOw = trySelfOverwritingDecoder(fbody, funcName, arraySource);
    if (selfOw !== null) return { name: funcName, index: i, offset: selfOw };
  }
  return null;
}

/** Simple decoder: 1 or 2 statements (optional offset assignment + return). */
function trySimpleDecoder(
  fbody: Statement[],
  funcDecl: t.FunctionDeclaration,
  arraySource: ArraySource,
): number | null {
  const paramName = t.isIdentifier(funcDecl.params[0]) ? funcDecl.params[0].name : null;
  if (!paramName) return null;

  // Single return: return ARRAY_REF[param] or ARRAY_REF[param - OFFSET]
  if (fbody.length === 1 && t.isReturnStatement(fbody[0])) {
    return extractOffsetFromReturn(fbody[0] as t.ReturnStatement, paramName, arraySource);
  }

  // Offset assignment + return: param = param - OFFSET; return ARRAY_REF[param]
  if (fbody.length === 2 && t.isExpressionStatement(fbody[0]) && t.isReturnStatement(fbody[1])) {
    const offset = extractOffsetFromAssignment((fbody[0] as t.ExpressionStatement).expression, paramName);
    if (offset === null) return null;
    const ret = (fbody[1] as t.ReturnStatement).argument;
    if (!ret || !t.isMemberExpression(ret) || !ret.computed) return null;
    if (!matchesArrayRef(ret.object, arraySource)) return null;
    if (!t.isIdentifier(ret.property) || ret.property.name !== paramName) return null;
    return offset;
  }

  return null;
}

/** Self-overwriting decoder: var arr=PROVIDER(); FUNC=function(...){...}; return FUNC(...); */
function trySelfOverwritingDecoder(
  fbody: Statement[],
  funcName: string,
  arraySource: ArraySource,
): number | null {
  if (fbody.length !== 3) return null;

  // Statement 1: var LOCAL = PROVIDER()
  if (!t.isVariableDeclaration(fbody[0])) return null;
  const decl = (fbody[0] as t.VariableDeclaration).declarations[0];
  if (!decl || !t.isIdentifier(decl.id)) return null;
  if (!t.isCallExpression(decl.init)) return null;
  if (!t.isIdentifier(decl.init.callee) || decl.init.callee.name !== arraySource.name) return null;
  const localArrayName = decl.id.name;

  // Statement 2: funcName = function(...) { ... }
  if (!t.isExpressionStatement(fbody[1])) return null;
  const assign = (fbody[1] as t.ExpressionStatement).expression;
  if (!t.isAssignmentExpression(assign)) return null;
  if (!t.isIdentifier(assign.left) || assign.left.name !== funcName) return null;
  if (!t.isFunctionExpression(assign.right)) return null;

  const innerFunc = assign.right;
  if (innerFunc.params.length < 1) return null;
  const innerParam = t.isIdentifier(innerFunc.params[0]) ? innerFunc.params[0].name : null;
  if (!innerParam) return null;

  const innerBody = innerFunc.body.body;
  let offset = 0;
  let startIdx = 0;

  // Optional offset assignment as first statement
  if (innerBody.length >= 1 && t.isExpressionStatement(innerBody[0])) {
    const extracted = extractOffsetFromAssignment(
      (innerBody[0] as t.ExpressionStatement).expression,
      innerParam,
    );
    if (extracted !== null) {
      offset = extracted;
      startIdx = 1;
    }
  }

  const remaining = innerBody.slice(startIdx);

  // Pattern: var v = LOCAL[param]; return v;
  if (remaining.length === 2 && t.isVariableDeclaration(remaining[0]) && t.isReturnStatement(remaining[1])) {
    const vDecl = (remaining[0] as t.VariableDeclaration).declarations[0];
    if (!vDecl || !t.isIdentifier(vDecl.id)) return null;
    if (!t.isMemberExpression(vDecl.init) || !vDecl.init.computed) return null;
    if (!t.isIdentifier(vDecl.init.object) || vDecl.init.object.name !== localArrayName) return null;
    if (!t.isIdentifier(vDecl.init.property) || vDecl.init.property.name !== innerParam) return null;
    const retArg = (remaining[1] as t.ReturnStatement).argument;
    if (!t.isIdentifier(retArg) || retArg.name !== vDecl.id.name) return null;
    return offset;
  }

  // Pattern: return LOCAL[param];
  if (remaining.length === 1 && t.isReturnStatement(remaining[0])) {
    const retArg = (remaining[0] as t.ReturnStatement).argument;
    if (!t.isMemberExpression(retArg) || !retArg.computed) return null;
    if (!t.isIdentifier(retArg.object) || retArg.object.name !== localArrayName) return null;
    if (!t.isIdentifier(retArg.property) || retArg.property.name !== innerParam) return null;
    return offset;
  }

  return null;
}

function extractOffsetFromReturn(
  ret: t.ReturnStatement,
  paramName: string,
  arraySource: ArraySource,
): number | null {
  const arg = ret.argument;
  if (!arg || !t.isMemberExpression(arg) || !arg.computed) return null;
  if (!matchesArrayRef(arg.object, arraySource)) return null;

  const prop = arg.property;
  if (t.isIdentifier(prop) && prop.name === paramName) return 0;
  if (
    t.isBinaryExpression(prop) && prop.operator === "-" &&
    t.isIdentifier(prop.left) && prop.left.name === paramName &&
    t.isNumericLiteral(prop.right)
  ) {
    return prop.right.value;
  }
  return null;
}

/** Check if node references the array source (direct name or provider call). */
function matchesArrayRef(node: any, arraySource: ArraySource): boolean {
  if (t.isIdentifier(node) && node.name === arraySource.name) return true;
  if (
    t.isCallExpression(node) && t.isIdentifier(node.callee) &&
    node.callee.name === arraySource.name && node.arguments.length === 0
  ) return true;
  return false;
}

/** Extract offset from `param = param - OFFSET`. */
function extractOffsetFromAssignment(expr: any, paramName: string): number | null {
  if (!t.isAssignmentExpression(expr) || expr.operator !== "=") return null;
  if (!t.isIdentifier(expr.left) || expr.left.name !== paramName) return null;
  if (
    t.isBinaryExpression(expr.right) && expr.right.operator === "-" &&
    t.isIdentifier(expr.right.left) && expr.right.left.name === paramName &&
    t.isNumericLiteral(expr.right.right)
  ) {
    return expr.right.right.value;
  }
  return null;
}

// --- Alias tracking ---

function findAliases(ast: File, decoderName: string): AliasInfo[] {
  const aliases: AliasInfo[] = [];
  const body = ast.program.body;

  // Top-level: var ALIAS = DECODER
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id)) continue;
      if (!t.isIdentifier(decl.init)) continue;
      if (decl.init.name !== decoderName) continue;
      aliases.push({ name: decl.id.name, topLevelIndex: i });
    }
  }

  // Function-scoped: var LOCAL = DECODER
  traverse(ast, {
    VariableDeclarator(path) {
      if (!path.scope.parent) return;
      const node = path.node;
      if (!t.isIdentifier(node.id)) return;
      if (!t.isIdentifier(node.init)) return;
      if (node.init.name !== decoderName) return;
      if (aliases.some(a => a.name === (node.id as t.Identifier).name)) return;
      aliases.push({ name: (node.id as t.Identifier).name, topLevelIndex: null });
    },
  });

  return aliases;
}

// --- Rotation guard ---

/** Bail out if any IIFE receives the array source as an argument (likely rotation). */
function hasRotationIIFE(body: Statement[], arraySourceName: string): boolean {
  for (const stmt of body) {
    if (!t.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!t.isCallExpression(expr)) continue;
    const callee = expr.callee;
    if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) continue;
    if (expr.arguments.some(arg => t.isIdentifier(arg) && (arg as t.Identifier).name === arraySourceName)) {
      return true;
    }
  }
  return false;
}

// --- Encoding ---

function detectEncoding(elements: string[]): "none" | "base64" {
  let base64Matches = 0;
  for (const el of elements) {
    if (BASE64_TO_PLAIN.has(el)) base64Matches++;
  }
  if (base64Matches >= 2) return "base64";
  return "none";
}

function decodeElements(elements: string[], encoding: "none" | "base64"): string[] | null {
  if (encoding === "none") return elements;
  if (encoding === "base64") {
    try {
      return elements.map(el => Buffer.from(el, "base64").toString("utf-8"));
    } catch {
      return null;
    }
  }
  return null;
}

// --- Cleanup ---

function removeSetup(ast: File, pattern: StaticPattern): void {
  const indicesToRemove = new Set<number>();
  indicesToRemove.add(pattern.arraySource.index);
  indicesToRemove.add(pattern.decoder.index);
  for (const alias of pattern.aliases) {
    if (alias.topLevelIndex !== null) {
      indicesToRemove.add(alias.topLevelIndex);
    }
  }

  const sorted = [...indicesToRemove].sort((a, b) => b - a);
  for (const idx of sorted) {
    if (idx >= 0 && idx < ast.program.body.length) {
      ast.program.body.splice(idx, 1);
    }
  }
}
