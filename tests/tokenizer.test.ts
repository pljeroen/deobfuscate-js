import { describe, it, expect } from "vitest";
import { tokenize } from "../src/tokenizer.js";
import { TokenType } from "../src/types.js";

describe("tokenizer", () => {
  it("tokenizes an empty string to just EOF", () => {
    const tokens = tokenize("");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe(TokenType.EOF);
  });

  it("tokenizes a simple variable declaration", () => {
    const tokens = tokenize("var x = 1;");
    const significant = tokens.filter(
      (t) => t.type !== TokenType.Whitespace && t.type !== TokenType.EOF
    );
    expect(significant.map((t) => [t.type, t.value])).toEqual([
      [TokenType.Keyword, "var"],
      [TokenType.Identifier, "x"],
      [TokenType.Punctuator, "="],
      [TokenType.Number, "1"],
      [TokenType.Punctuator, ";"],
    ]);
  });

  it("tokenizes string literals with escapes", () => {
    const tokens = tokenize(`"hello \\"world\\""`);
    const strings = tokens.filter((t) => t.type === TokenType.String);
    expect(strings).toHaveLength(1);
    expect(strings[0].value).toBe(`"hello \\"world\\""`);
  });

  it("tokenizes multi-character operators", () => {
    const tokens = tokenize("a === b !== c");
    const ops = tokens.filter((t) => t.type === TokenType.Punctuator);
    expect(ops.map((t) => t.value)).toEqual(["===", "!=="]);
  });

  it("tokenizes arrow functions", () => {
    const tokens = tokenize("(x) => x + 1");
    const significant = tokens.filter(
      (t) => t.type !== TokenType.Whitespace && t.type !== TokenType.EOF
    );
    expect(significant.map((t) => t.value)).toEqual([
      "(", "x", ")", "=>", "x", "+", "1",
    ]);
  });

  it("survives a chunk of real minified lodash", () => {
    // Just the opening of lodash.min.js — should tokenize without throwing
    const sample = `;(function(){function n(n,t,r){switch(n){case 1:return t;case 2:return r}}}).call(this);`;
    const tokens = tokenize(sample);
    expect(tokens.length).toBeGreaterThan(10);
    expect(tokens[tokens.length - 1].type).toBe(TokenType.EOF);
  });
});
