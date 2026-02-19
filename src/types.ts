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

// AST node types (subset sufficient for de-obfuscation)
export type ASTNode =
  | Program
  | Statement
  | Expression
  | Declaration;

export interface Program {
  type: "Program";
  body: Statement[];
  start: number;
  end: number;
}

// Placeholder — will be expanded as we build the parser
export interface Statement {
  type: string;
  [key: string]: unknown;
}

export interface Expression {
  type: string;
  [key: string]: unknown;
}

export interface Declaration {
  type: string;
  [key: string]: unknown;
}

// Pipeline pass interface
export interface DeobfuscationPass {
  name: string;
  description: string;
  run(input: string): string;
}
