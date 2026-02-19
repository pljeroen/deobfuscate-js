# deobfuscate-js

![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Tests](https://img.shields.io/badge/tests-194%20passing-green) ![Node](https://img.shields.io/badge/node-18%2B-blue) ![Architecture](https://img.shields.io/badge/AST-Babel-purple)

JavaScript de-obfuscation toolkit. Combines AST-based transforms (constant folding, dead code elimination, scope-aware renaming) with token-level formatting to produce readable output from minified or obfuscated JavaScript.

## Quick Start

```bash
npm install
npm run deobfuscate                          # input/lodash.min.js -> output/lodash.deobfuscated.js
npm run deobfuscate -- path/to/input.js out.js  # custom paths
```

## Pipeline

Two-phase pipeline: AST transforms (parse once, transform, generate) followed by token-level formatting.

### AST Phase

Parses input with `@babel/parser`, applies transforms via `@babel/traverse`, generates output with `@babel/generator`.

#### Constant Folding

Evaluates static expressions at deobfuscation time:

| Pattern | Result |
|---|---|
| `1 + 2` | `3` |
| `"hel" + "lo"` | `"hello"` |
| `!0` / `!1` | `true` / `false` |
| `void 0` | `undefined` |
| `typeof "x"` | `"string"` |
| `true && false` | `false` |

#### Constant Propagation

Inlines variables assigned exactly once to a literal value, where the binding is never reassigned.

#### Dead Code Elimination

- Removes `if(false)` blocks, simplifies `if(true)` to consequent only
- Removes unreachable statements after `return`/`throw`
- Removes unused variable declarations (when initializer has no side effects)
- Simplifies constant ternary expressions

#### Hex/Unicode String Decoding

Decodes `\xHH`, `\uHHHH`, and `\u{HHHH}` escape sequences in string literals back to readable characters.

#### Simplification

- Splits comma expression statements into separate statements
- Converts computed member access (`obj["prop"]`) to dot access (`obj.prop`) where valid

#### Scope-Aware Renaming

Replaces single-letter and two-letter minified variable names with descriptive names using Babel's scope analysis for correct lexical scoping, hoisting, and closure handling.

- Each function's bindings renamed independently via `scope.rename()`
- Conventional names preserved: `i`, `j`, `k`, `_`, `$`
- Well-known globals never renamed

### Token Phase

#### Format

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
| Lines | 139 | 2,355 | 17x |
| Bytes | 73,320 | 160,729 | 2.2x |
| Single-letter identifiers | 8,507 (65%) | 759 (4%) | -91% |
| Boolean idioms (`!0`, `!1`) | 113 | 0 | -100% |

Output passes `node --check` — syntactically valid JavaScript.

## Testing

```bash
npm test           # run all tests (194)
npm run test:watch # watch mode
```

## Roadmap

- Proxy function inlining
- Object-key mapping resolution
- String array + decoder resolution (obfuscator.io patterns)
- Control flow unflattening
- Bundler unpacking (webpack/browserify)
- Iterative convergence (apply transforms until fixpoint)
- Obfuscator fingerprinting

## License

[MIT](LICENSE)
