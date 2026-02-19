# JavaScript De-obfuscation Report

Target: `lodash.min.js` v4.17.23 (73,320 bytes, 139 lines)

## Results

| Metric | Input | Output | Change |
|---|---|---|---|
| Lines | 139 | 2,519 | 18x |
| Bytes | 73,320 | 127,378 | 1.7x |
| Tokens | 40,862 | 59,900 | +47% |
| Single-letter identifiers | 8,507 (65%) | 2,494 (19%) | -71% |
| Boolean idioms (`!0`, `!1`) | 113 | 0 | -100% |

Output passes `node --check` — syntactically valid JavaScript.

## Pipeline

Three sequential passes, all operating at the token level. No AST parser, no
external dependencies.

### 1. Simplify

Reverses common minification idioms:

| Pattern | Replacement |
|---|---|
| `!0` | `true` |
| `!1` | `false` |
| `void 0` | `undefined` |
| Comma expressions `a,b,c;` | Separate statements `a;\nb;\nc;` |

Comma expression splitting works inside function bodies, not just top-level.
Correctly handles brace-less control structure bodies (`if`/`else`/`for`/`while`/`do`)
and preserves `return`/`throw` comma expressions.

Guards against false positives: commas inside `()`, `[]`, `{}`, and
`var`/`let`/`const` declarations are preserved.

### 2. Rename

Replaces single-letter and two-letter minified variable names with descriptive
names from a fixed vocabulary (`value`, `other`, `result`, `data`, `key`, ...).

- Scoped per function: each function's params and locals are renamed
  independently
- Inner scopes take precedence over outer scopes (no duplicate param names)
- Conventional names preserved: `i`, `j`, `k`, `_`, `$`
- Property access (`.foo`) and object keys (`{a: 1}`) are not renamed
- Well-known globals (`Array`, `Object`, `Math`, etc.) are not renamed

### 3. Format

Tokenizes input, strips original whitespace, re-emits with:

- Newlines after `;`, `{`, `}`
- 2-space indentation tracking brace depth
- Spaces around binary/assignment operators and after commas
- Keyword-to-word spacing (`if (`, `for (`, `while (`, `return value`)
- Unary minus handling (no space after `-` in unary context)
- For-loop awareness: semicolons inside `for(;;)` do not trigger line breaks

## Tooling

| Component | Lines | Purpose |
|---|---|---|
| `src/tokenizer.ts` | 244 | From-scratch JS lexer |
| `src/passes/simplify.ts` | 265 | Idiom reversal |
| `src/passes/rename.ts` | 304 | Scoped variable renaming |
| `src/passes/format.ts` | 284 | Pretty-printer |
| `src/pipeline.ts` | 13 | Sequential pass runner |
| `src/types.ts` | 72 | Token/AST/pass type definitions |
| `src/index.ts` | 28 | CLI entry point |
| **Total source** | **1,210** | |
| **Total tests** | **513** (80 tests) | |

Zero external dependencies for de-obfuscation logic. Dev tooling only:
TypeScript, tsx, vitest.

## Limitations

- **No AST**: operates at token level, so cannot distinguish all syntactic
  contexts perfectly (e.g., ternary `:` vs object key `:`)
- **Rename vocabulary is generic**: names like `value`, `other` are better than
  `n`, `t` but don't reflect actual semantics
- **No constant inlining**: string constants like `Dn = "[object Arguments]"`
  are not inlined at usage sites
- **No function name recovery**: `_.map = function(...)` could infer the name
  `map` but currently does not
- **Long lines**: some statements with many chained expressions remain on
  single lines

## Possible improvements

1. Context-aware renaming (variables compared to `.length` -> `len`, loop
   counters -> `index`)
2. Constant inlining for string/number literals assigned once and used as tags
3. Function name recovery from property assignment patterns
4. Line-length-aware wrapping
