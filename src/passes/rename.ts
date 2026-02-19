/**
 * Variable renaming pass — replaces single-letter minified names
 * with more descriptive names based on usage context heuristics.
 *
 * Strategy:
 * 1. Scan for function declarations / expressions / arrows
 * 2. Collect their parameter names and local var names
 * 3. For single-letter names (except conventional ones), generate replacements
 * 4. Apply replacements per scope, respecting property access and object keys
 */

import { tokenize } from "../tokenizer.js";
import { TokenType, DeobfuscationPass } from "../types.js";
import type { Token } from "../types.js";

// Names that are conventional and should not be renamed
const KEEP_NAMES = new Set(["i", "j", "k", "x", "y", "z", "_", "$"]);

// Well-known global names
const GLOBALS = new Set([
  "undefined", "null", "NaN", "Infinity",
  "console", "window", "global", "globalThis", "self",
  "document", "navigator", "location", "history",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "Promise", "Symbol", "Proxy", "Reflect",
  "Array", "Object", "String", "Number", "Boolean", "Function",
  "Map", "Set", "WeakMap", "WeakSet",
  "Error", "TypeError", "RangeError", "ReferenceError",
  "JSON", "Math", "Date", "RegExp",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent",
  "require", "module", "exports", "__dirname", "__filename",
  "arguments", "this",
]);

const PARAM_NAMES = [
  "value", "other", "result", "data", "key", "source",
  "object", "target", "predicate", "iteratee", "accumulator",
  "collection", "callback", "context", "args", "guard",
  "start", "end", "step", "depth", "customizer",
];

export const renamePass: DeobfuscationPass = {
  name: "rename",
  description: "Rename single-letter variables to descriptive names based on usage patterns",

  run(input: string): string {
    const tokens = tokenize(input);
    const scopes = collectScopes(tokens);
    return applyRenames(tokens, scopes);
  },
};

interface ScopeInfo {
  // Token index range [start, end) for this function scope
  startIdx: number;
  endIdx: number;
  renames: Map<string, string>;
}

function shouldRename(name: string): boolean {
  if (name.length > 2) return false;
  if (KEEP_NAMES.has(name)) return false;
  if (GLOBALS.has(name)) return false;
  return true;
}

function generateName(index: number): string {
  if (index < PARAM_NAMES.length) return PARAM_NAMES[index];
  return `var${index - PARAM_NAMES.length + 1}`;
}

function collectScopes(tokens: Token[]): ScopeInfo[] {
  const scopes: ScopeInfo[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];

    // Detect function keyword or arrow function
    const isFunctionKeyword = tok.type === TokenType.Keyword && tok.value === "function";
    const arrowParenIdx = findArrowAfterParens(tokens, i);

    if (isFunctionKeyword || arrowParenIdx !== false) {
      const scope: ScopeInfo = {
        startIdx: i,
        endIdx: tokens.length, // will be refined
        renames: new Map(),
      };
      let paramIdx = 0;

      // Find the opening paren
      let parenStart = -1;
      if (isFunctionKeyword) {
        let j = i + 1;
        while (j < tokens.length && tokens[j].type === TokenType.Whitespace) j++;
        if (j < tokens.length && tokens[j].type === TokenType.Identifier) j++;
        while (j < tokens.length && tokens[j].type === TokenType.Whitespace) j++;
        if (j < tokens.length && tokens[j].type === TokenType.Punctuator && tokens[j].value === "(") {
          parenStart = j;
        }
      } else if (arrowParenIdx !== false) {
        parenStart = arrowParenIdx;
      }

      if (parenStart >= 0) {
        // Collect param names between ( and )
        let j = parenStart + 1;
        while (j < tokens.length) {
          const t = tokens[j];
          if (t.type === TokenType.Punctuator && t.value === ")") break;
          if (t.type === TokenType.Identifier && shouldRename(t.value)) {
            if (!scope.renames.has(t.value)) {
              scope.renames.set(t.value, generateName(paramIdx++));
            }
          }
          j++;
        }
      }

      // Find the function body boundaries
      let bodyStart = -1;
      let bodyEnd = -1;
      {
        let j = isFunctionKeyword ? (parenStart >= 0 ? parenStart : i) : i;
        while (j < tokens.length) {
          if (tokens[j].type === TokenType.Punctuator && tokens[j].value === "{") {
            bodyStart = j;
            break;
          }
          if (tokens[j].type === TokenType.Punctuator && tokens[j].value === "=>") {
            // Arrow without braces — find end of expression
            // For simplicity, scope extends to next ; or ) at depth 0
            scope.startIdx = parenStart >= 0 ? parenStart : i;
            scope.endIdx = findExpressionEnd(tokens, j + 1);
            break;
          }
          j++;
        }
      }

      if (bodyStart >= 0) {
        // Find matching closing brace
        let depth = 0;
        let j = bodyStart;
        while (j < tokens.length) {
          if (tokens[j].type === TokenType.Punctuator && tokens[j].value === "{") depth++;
          if (tokens[j].type === TokenType.Punctuator && tokens[j].value === "}") {
            depth--;
            if (depth === 0) {
              bodyEnd = j;
              break;
            }
          }
          j++;
        }

        scope.startIdx = parenStart >= 0 ? parenStart : i;
        scope.endIdx = bodyEnd >= 0 ? bodyEnd + 1 : tokens.length;

        // Collect var/let/const declarations (only immediate depth)
        if (bodyEnd >= 0) {
          depth = 0;
          for (let j = bodyStart; j <= bodyEnd; j++) {
            if (tokens[j].type === TokenType.Punctuator && tokens[j].value === "{") depth++;
            if (tokens[j].type === TokenType.Punctuator && tokens[j].value === "}") depth--;
            // Only collect at depth 1 (the function's own block)
            if (depth === 1 &&
              tokens[j].type === TokenType.Keyword &&
              (tokens[j].value === "var" || tokens[j].value === "let" || tokens[j].value === "const")
            ) {
              let k = j + 1;
              while (k < tokens.length && tokens[k].type === TokenType.Whitespace) k++;
              if (k < tokens.length && tokens[k].type === TokenType.Identifier && shouldRename(tokens[k].value)) {
                if (!scope.renames.has(tokens[k].value)) {
                  scope.renames.set(tokens[k].value, generateName(paramIdx++));
                }
              }
            }
          }
        }
      }

      if (scope.renames.size > 0) {
        scopes.push(scope);
      }
    }

    i++;
  }

  return scopes;
}

function findExpressionEnd(tokens: Token[], start: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].type === TokenType.Punctuator) {
      switch (tokens[i].value) {
        case "(": parenDepth++; break;
        case ")":
          if (parenDepth === 0) return i;
          parenDepth--;
          break;
        case "[": bracketDepth++; break;
        case "]": bracketDepth--; break;
        case ";":
        case ",":
          if (parenDepth === 0 && bracketDepth === 0) return i;
          break;
      }
    }
  }
  return tokens.length;
}

function findArrowAfterParens(tokens: Token[], i: number): number | false {
  const tok = tokens[i];
  if (tok.type !== TokenType.Punctuator || tok.value !== "(") return false;

  // Find matching close paren
  let depth = 0;
  let j = i;
  while (j < tokens.length) {
    if (tokens[j].type === TokenType.Punctuator && tokens[j].value === "(") depth++;
    if (tokens[j].type === TokenType.Punctuator && tokens[j].value === ")") {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }

  // Check if => follows
  let k = j + 1;
  while (k < tokens.length && tokens[k].type === TokenType.Whitespace) k++;
  if (k < tokens.length && tokens[k].type === TokenType.Punctuator && tokens[k].value === "=>") {
    return i;
  }
  return false;
}

function applyRenames(tokens: Token[], scopes: ScopeInfo[]): string {
  const tokenRenames = new Map<number, string>(); // token index → new name

  // Sort scopes by range size ascending (innermost first).
  // Inner scopes get priority via the !tokenRenames.has(i) check.
  const sortedScopes = [...scopes].sort(
    (a, b) => (a.endIdx - a.startIdx) - (b.endIdx - b.startIdx)
  );

  for (const scope of sortedScopes) {
    // Only apply renames within this scope's boundaries
    for (let i = scope.startIdx; i < scope.endIdx && i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type === TokenType.Identifier && scope.renames.has(tok.value)) {
        // Don't rename property access (after .)
        if (i > 0) {
          let prev = i - 1;
          while (prev >= 0 && tokens[prev].type === TokenType.Whitespace) prev--;
          if (prev >= 0 && tokens[prev].type === TokenType.Punctuator && tokens[prev].value === ".") {
            continue;
          }
        }
        // Don't rename object keys
        if (isObjectKey(tokens, i)) {
          continue;
        }

        // Only set if not already renamed by a more specific (inner) scope
        if (!tokenRenames.has(i)) {
          tokenRenames.set(i, scope.renames.get(tok.value)!);
        }
      }
    }
  }

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === TokenType.EOF) continue;
    if (tokenRenames.has(i)) {
      out.push(tokenRenames.get(i)!);
    } else {
      out.push(tokens[i].value);
    }
  }

  return out.join("");
}

function isObjectKey(tokens: Token[], i: number): boolean {
  let j = i + 1;
  while (j < tokens.length && tokens[j].type === TokenType.Whitespace) j++;
  if (j >= tokens.length) return false;
  if (tokens[j].type !== TokenType.Punctuator || tokens[j].value !== ":") return false;

  let k = i - 1;
  while (k >= 0 && tokens[k].type === TokenType.Whitespace) k--;
  if (k < 0) return false;
  if (tokens[k].type === TokenType.Punctuator && (tokens[k].value === "{" || tokens[k].value === ",")) {
    return true;
  }
  return false;
}
