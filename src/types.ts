// Token types produced by the tokenizer
export enum TokenType {
  // Literals
  Number = "Number",
  String = "String",
  RegExp = "RegExp",
  Template = "Template",

  // Identifiers & keywords
  Identifier = "Identifier",
  Keyword = "Keyword",

  // Punctuation & operators
  Punctuator = "Punctuator",

  // Comments
  LineComment = "LineComment",
  BlockComment = "BlockComment",

  // Whitespace (preserved for formatting pass)
  Whitespace = "Whitespace",
  LineTerminator = "LineTerminator",

  // End of input
  EOF = "EOF",
}

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

import type { File } from "@babel/types";

// AST-based pass interface (operates on Babel AST)
export interface ASTPass {
  name: string;
  description: string;
  safety?: "safe" | "unsafe";
  run(ast: File): File;
}

// Token-based pass interface (operates on source string)
export interface TokenPass {
  name: string;
  description: string;
  run(input: string): string;
}

// Legacy alias
export type DeobfuscationPass = TokenPass;
