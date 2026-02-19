/**
 * Obfuscator fingerprinting — detect which obfuscation tool was used
 * by recognizing structural patterns in the AST.
 */

import type { File } from "@babel/types";
import { traverse, t } from "./babel.js";

export interface FingerprintResult {
  obfuscator: string | null;
  confidence: number;
  patterns: string[];
}

const HEX_PREFIX = /^_0x/;

/**
 * Analyze an AST and attempt to identify the obfuscation tool used.
 * Currently detects javascript-obfuscator patterns.
 */
export function fingerprint(ast: File): FingerprintResult {
  const patterns: string[] = [];

  if (detectHexIdentifiers(ast)) patterns.push("hex-identifiers");
  if (detectStringArrayDecoder(ast)) patterns.push("string-array-decoder");
  if (detectControlFlowFlattening(ast)) patterns.push("control-flow-flattening");

  if (patterns.length === 0) {
    return { obfuscator: null, confidence: 0, patterns: [] };
  }

  const confidence = Math.min(1, patterns.length * 0.3 + 0.2);
  return { obfuscator: "javascript-obfuscator", confidence, patterns };
}

/** Detect _0x-prefixed identifiers typical of javascript-obfuscator. */
function detectHexIdentifiers(ast: File): boolean {
  const hexNames = new Set<string>();

  traverse(ast, {
    Identifier(path) {
      if (HEX_PREFIX.test(path.node.name)) {
        hexNames.add(path.node.name);
      }
    },
  });

  return hexNames.size >= 3;
}

/** Detect string array + decoder function pattern. */
function detectStringArrayDecoder(ast: File): boolean {
  let hasStringArray = false;
  let hasDecoderFunction = false;

  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      if (!HEX_PREFIX.test(path.node.id.name)) return;

      // Array of string literals assigned to a _0x variable
      if (t.isArrayExpression(path.node.init)) {
        const allStrings = path.node.init.elements.every(
          el => t.isStringLiteral(el),
        );
        if (allStrings && path.node.init.elements.length >= 2) {
          hasStringArray = true;
        }
      }
    },

    FunctionDeclaration(path) {
      if (!path.node.id || !HEX_PREFIX.test(path.node.id.name)) return;

      // Function that returns array[index] pattern
      const body = path.node.body.body;
      if (body.length === 1 && t.isReturnStatement(body[0])) {
        const arg = body[0].argument;
        if (t.isMemberExpression(arg) && t.isIdentifier(arg.object) && HEX_PREFIX.test(arg.object.name)) {
          hasDecoderFunction = true;
        }
      }
    },
  });

  return hasStringArray && hasDecoderFunction;
}

/** Detect control flow flattening: while(!![])/switch with .split('|') order. */
function detectControlFlowFlattening(ast: File): boolean {
  let found = false;

  traverse(ast, {
    WhileStatement(path) {
      // Check for while(!![]) or while(true)
      const test = path.node.test;
      const isTruthy =
        (t.isUnaryExpression(test) && test.operator === "!" &&
          t.isUnaryExpression(test.argument) && test.argument.operator === "!" &&
          t.isArrayExpression(test.argument.argument)) ||
        (t.isBooleanLiteral(test) && test.value === true);

      if (!isTruthy) return;

      // Check for switch statement in body
      const body = path.node.body;
      if (!t.isBlockStatement(body)) return;

      const hasSwitch = body.body.some(s => t.isSwitchStatement(s));
      if (!hasSwitch) return;

      // Check for .split('|') in surrounding scope
      const parent = path.parentPath;
      if (!parent) return;

      let hasSplitPipe = false;
      const siblings = t.isBlockStatement(parent.node)
        ? parent.node.body
        : t.isProgram(parent.node)
          ? parent.node.body
          : [];

      for (const stmt of siblings) {
        if (!t.isVariableDeclaration(stmt)) continue;
        for (const decl of stmt.declarations) {
          if (!t.isCallExpression(decl.init)) continue;
          const callee = decl.init.callee;
          if (
            t.isMemberExpression(callee) &&
            t.isIdentifier(callee.property) &&
            callee.property.name === "split" &&
            decl.init.arguments.length === 1 &&
            t.isStringLiteral(decl.init.arguments[0]) &&
            decl.init.arguments[0].value === "|"
          ) {
            hasSplitPipe = true;
          }
        }
      }

      if (hasSplitPipe) {
        found = true;
        path.stop();
      }
    },
  });

  return found;
}
