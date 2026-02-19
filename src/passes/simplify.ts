/**
 * Simplification pass — reverses common minification patterns:
 * - !0 → true, !1 → false
 * - void 0 → undefined
 * - Comma expressions → separate statements (top-level only)
 */

import { tokenize } from "../tokenizer.js";
import { TokenType, DeobfuscationPass } from "../types.js";
import type { Token } from "../types.js";

export const simplifyPass: DeobfuscationPass = {
  name: "simplify",
  description: "Reverse common minification idioms back to readable equivalents",

  run(input: string): string {
    const tokens = tokenize(input);
    let result = applyBooleanAndVoidReplacements(tokens);
    result = splitCommaExpressions(result);
    return result;
  },
};

/**
 * Replace !0 → true, !1 → false, void 0 → undefined
 * Works by scanning token pairs and replacing matching sequences.
 */
function needsSpaceBefore(out: string[]): boolean {
  const last = out[out.length - 1];
  return !!last && /[a-zA-Z_$]$/.test(last);
}

function applyBooleanAndVoidReplacements(tokens: Token[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];

    // !0 → true, !1 → false
    if (
      tok.type === TokenType.Punctuator &&
      tok.value === "!" &&
      i + 1 < tokens.length &&
      tokens[i + 1].type === TokenType.Number
    ) {
      const numTok = tokens[i + 1];
      if (numTok.value === "0") {
        if (needsSpaceBefore(out)) out.push(" ");
        out.push("true");
        i += 2;
        continue;
      }
      if (numTok.value === "1") {
        if (needsSpaceBefore(out)) out.push(" ");
        out.push("false");
        i += 2;
        continue;
      }
    }

    // void 0 → undefined
    if (
      tok.type === TokenType.Keyword &&
      tok.value === "void" &&
      i + 1 < tokens.length
    ) {
      // Skip whitespace to find the operand
      let j = i + 1;
      const wsTokens: string[] = [];
      while (j < tokens.length && tokens[j].type === TokenType.Whitespace) {
        wsTokens.push(tokens[j].value);
        j++;
      }
      if (j < tokens.length && tokens[j].type === TokenType.Number && tokens[j].value === "0") {
        if (needsSpaceBefore(out)) out.push(" ");
        out.push("undefined");
        i = j + 1;
        continue;
      }
    }

    if (tok.type !== TokenType.EOF) {
      out.push(tok.value);
    }
    i++;
  }

  return out.join("");
}

/**
 * Split comma expressions into separate statements.
 * Splits commas at statement level inside blocks (function bodies, if/for/while bodies).
 * Does NOT split inside: parens, brackets, object literals, or var/let/const declarations.
 */
function splitCommaExpressions(input: string): string {
  const tokens = tokenize(input);
  const out: string[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let inDeclaration = false;
  // Stack tracks whether each brace level is a block (true) or object literal (false)
  const braceStack: boolean[] = [];
  // Stacks save/restore state when entering/exiting blocks so that
  // block-level comma splitting works inside IIFEs and nested functions
  const declarationStack: boolean[] = [];
  const parenDepthStack: number[] = [];
  const bracketDepthStack: number[] = [];

  // Tracks brace-less control structure bodies (if/else/for/while/do without {})
  // where commas must not be split because they're comma operators inside a single statement.
  // Uses a depth counter because bodies can nest: if(a) if(b) x,y;
  let bracelessBody = false;
  const bracelessBodyStack: boolean[] = [];

  // State machine for detecting brace-less bodies after if/for/while conditions.
  // controlParenStart records parenDepth before the opening ( of the condition.
  let controlParenStart = -1;

  // Tracks return/throw expressions where commas are the comma operator, not statement separators.
  // `return a,b` returns b; splitting into `return a; b` would change semantics.
  let inReturnExpr = false;
  const inReturnExprStack: boolean[] = [];

  function prevSignificant(idx: number): Token | undefined {
    for (let j = idx - 1; j >= 0; j--) {
      if (tokens[j].type !== TokenType.Whitespace && tokens[j].type !== TokenType.LineTerminator) {
        return tokens[j];
      }
    }
    return undefined;
  }

  function nextSignificant(idx: number): Token | undefined {
    for (let j = idx + 1; j < tokens.length; j++) {
      if (tokens[j].type !== TokenType.Whitespace && tokens[j].type !== TokenType.LineTerminator) {
        return tokens[j];
      }
    }
    return undefined;
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type === TokenType.Keyword && (tok.value === "var" || tok.value === "let" || tok.value === "const")) {
      inDeclaration = true;
    }

    // Track return/throw expressions — commas inside are the comma operator
    if (tok.type === TokenType.Keyword && (tok.value === "return" || tok.value === "throw")) {
      inReturnExpr = true;
    }

    // Detect control structure keywords that take a parenthesized condition.
    // After seeing if/for/while, look ahead: if followed by `(`, the `)` that matches
    // it will trigger a body check.
    if (tok.type === TokenType.Keyword && (tok.value === "if" || tok.value === "for" || tok.value === "while")) {
      controlParenStart = parenDepth;
    }

    // Detect brace-less do body
    if (tok.type === TokenType.Keyword && tok.value === "do") {
      const next = nextSignificant(i);
      if (!next || next.value !== "{") {
        bracelessBody = true;
      }
    }

    // Detect brace-less else body
    if (tok.type === TokenType.Keyword && tok.value === "else") {
      const next = nextSignificant(i);
      if (next && next.value !== "{" && next.value !== "if") {
        bracelessBody = true;
      }
    }

    if (tok.type === TokenType.Punctuator) {
      switch (tok.value) {
        case "(":
          parenDepth++;
          break;
        case ")": {
          parenDepth--;
          // Check if this `)` closes a control condition (if/for/while)
          if (controlParenStart >= 0 && parenDepth === controlParenStart) {
            controlParenStart = -1;
            const next = nextSignificant(i);
            if (next && next.value !== "{") {
              bracelessBody = true;
            }
          }
          break;
        }
        case "[":
          bracketDepth++;
          break;
        case "]":
          bracketDepth--;
          break;
        case "{": {
          // Determine if this brace opens a block or object literal
          const prev = prevSignificant(i);
          const isBlock = prev !== undefined && (
            (prev.type === TokenType.Punctuator && (prev.value === ")" || prev.value === "=>" || prev.value === "{" || prev.value === "}" || prev.value === ";")) ||
            (prev.type === TokenType.Keyword && (prev.value === "else" || prev.value === "do" || prev.value === "try" || prev.value === "finally"))
          );
          braceStack.push(isBlock);
          // Entering a block resets context — comma splitting inside
          // a function body shouldn't be blocked by outer parens or declarations
          if (isBlock) {
            declarationStack.push(inDeclaration);
            parenDepthStack.push(parenDepth);
            bracketDepthStack.push(bracketDepth);
            bracelessBodyStack.push(bracelessBody);
            inReturnExprStack.push(inReturnExpr);
            inDeclaration = false;
            parenDepth = 0;
            bracketDepth = 0;
            bracelessBody = false;
            inReturnExpr = false;
          }
          break;
        }
        case "}": {
          const wasBlock = braceStack.pop();
          // Restore context when leaving a block
          if (wasBlock && declarationStack.length > 0) {
            inDeclaration = declarationStack.pop()!;
            parenDepth = parenDepthStack.pop()!;
            bracketDepth = bracketDepthStack.pop()!;
            bracelessBody = bracelessBodyStack.pop()!;
            inReturnExpr = inReturnExprStack.pop()!;
          }
          break;
        }
        case ";":
          inDeclaration = false;
          inReturnExpr = false;
          // Semicolons end brace-less control structure bodies
          if (bracelessBody && parenDepth === 0) {
            bracelessBody = false;
          }
          break;
        case ",": {
          // Split if: not inside parens/brackets, not in a declaration,
          // not in a brace-less control body, not in a return/throw expr, and not in an object literal
          const inObjectLiteral = braceStack.length > 0 && !braceStack[braceStack.length - 1];
          if (parenDepth === 0 && bracketDepth === 0 && !inDeclaration && !inObjectLiteral && !bracelessBody && !inReturnExpr) {
            out.push(";\n");
            continue;
          }
          break;
        }
      }
    }

    // End of brace-less do body: the `while` keyword resets bracelessBody
    if (bracelessBody && tok.type === TokenType.Keyword && tok.value === "while") {
      const prev = prevSignificant(i);
      if (prev && prev.type === TokenType.Punctuator && prev.value === ";") {
        bracelessBody = false;
      }
    }

    if (tok.type !== TokenType.EOF) {
      out.push(tok.value);
    }
  }

  return out.join("");
}
