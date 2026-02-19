# deobfuscate-js

![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Tests](https://img.shields.io/badge/tests-93%20passing-green) ![Node](https://img.shields.io/badge/node-18%2B-blue) ![Dependencies](https://img.shields.io/badge/runtime%20deps-0-blue)

From-scratch JavaScript de-obfuscation toolkit. Reverses common minification patterns, renames single-letter variables, and pretty-prints the result — all at the token level, with zero runtime dependencies.

## Quick Start

```bash
npm install
npm run deobfuscate                          # input/lodash.min.js → output/lodash.deobfuscated.js
npm run deobfuscate -- path/to/input.js out.js  # custom paths
```

## Pipeline

Three sequential passes operate on a token stream produced by a built-in JavaScript lexer.

### 1. Simplify

Reverses common minification idioms back to readable equivalents:

| Pattern | Replacement |
|---|---|
| `!0` | `true` |
| `!1` | `false` |
| `void 0` | `undefined` |
| `a,b,c;` | `a;\nb;\nc;` (comma expression splitting) |

Comma splitting is scope-aware: it works inside function bodies but preserves commas in declarations, function arguments, array/object literals, and return expressions.

### 2. Rename

Replaces single-letter and two-letter minified variable names with descriptive names (`value`, `other`, `result`, `data`, `key`, ...).

- Scoped per function — each function's parameters and locals are renamed independently
- Inner scopes take precedence over outer scopes
- Conventional names preserved: `i`, `j`, `k`, `_`, `$`
- Property access and object keys are never renamed
- Well-known globals (`Array`, `Object`, `Math`, etc.) are left alone

### 3. Format

Re-emits the token stream with proper indentation and whitespace:

- Newlines after `;`, `{`, `}`
- 2-space indentation tracking brace depth
- Spaces around binary, assignment, and ternary operators
- Keyword spacing (`if (`, `return value`, `typeof x`)
- Context-aware unary operator handling
- For-loop awareness (no line breaks inside `for(;;)`)

## Results

Tested on `lodash.min.js` v4.17.23:

| Metric | Input | Output | Change |
|---|---|---|---|
| Lines | 139 | 2,519 | 18x |
| Bytes | 73,320 | 128,891 | 1.8x |
| Single-letter identifiers | 8,507 (65%) | 2,494 (19%) | -71% |
| Boolean idioms (`!0`, `!1`) | 113 | 0 | -100% |

Output passes `node --check` — syntactically valid JavaScript.

## Testing

```bash
npm test           # run all tests
npm run test:watch # watch mode
```

## Limitations

- **Token-level only** — no AST, so some syntactic contexts are approximated
- **Generic rename vocabulary** — names are descriptive but don't reflect actual semantics
- **No constant inlining** — string/number constants aren't propagated to usage sites
- **No function name recovery** — property assignment patterns like `_.map = function(...)` aren't used to infer names
- **No line wrapping** — long chained expressions remain on single lines

## License

[MIT](LICENSE)
