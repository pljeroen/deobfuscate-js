# JavaScript De-obfuscation Report

Target: `lodash.min.js` v4.17.23 (73,320 bytes, 139 lines)

## Results

| Metric | Input | Output | Change |
|---|---|---|---|
| Lines | 139 | 2,355 | 17x |
| Bytes | 73,320 | 160,729 | 2.2x |
| Tokens | 40,862 | ~65,000 | +59% |
| Single-letter identifiers | 8,507 (65%) | 759 (4%) | -91% |
| Boolean idioms (`!0`, `!1`) | 113 | 0 | -100% |

Output passes `node --check` — syntactically valid JavaScript.

## Pipeline

Two-phase architecture: AST transforms first, then token-level formatting.

### Phase 1: AST Transforms

Parses source once with `@babel/parser`, applies six transforms via
`@babel/traverse`, generates output once with `@babel/generator`.

| Pass | Function |
|---|---|
| Constant folding | `1+2` -> `3`, `!0` -> `true`, `void 0` -> `undefined` |
| Constant propagation | Inline single-assignment const/var with literal values |
| Dead code elimination | Remove `if(false)`, unreachable code, unused variables |
| Hex/unicode decoding | `\x48\x65\x6c\x6c\x6f` -> `Hello` |
| Simplification | Split comma expressions, `obj["prop"]` -> `obj.prop` |
| Scope-aware renaming | Babel scope analysis for correct lexical renaming |

### Phase 2: Token-Level Formatting

Custom tokenizer + format pass for indentation, line breaks, operator
spacing, keyword spacing, and context-aware unary handling.

## Tooling

| Component | Lines | Purpose |
|---|---|---|
| `src/babel.ts` | 15 | Babel ESM/CJS interop |
| `src/parser.ts` | 24 | Babel parse + generate wrappers |
| `src/pipeline.ts` | 40 | Dual-mode pipeline (AST + token) |
| `src/types.ts` | 39 | Token types, pass interfaces |
| `src/tokenizer.ts` | 244 | From-scratch JS lexer |
| `src/passes/constant-fold.ts` | 155 | Static expression evaluation |
| `src/passes/constant-propagate.ts` | 55 | Single-assignment inlining |
| `src/passes/dead-code-eliminate.ts` | 118 | Unreachable code removal |
| `src/passes/hex-decode.ts` | 38 | String escape decoding |
| `src/passes/ast-simplify.ts` | 62 | Comma splitting, member access |
| `src/passes/ast-rename.ts` | 75 | Babel scope-aware renaming |
| `src/passes/format.ts` | 309 | Token-level pretty-printer |
| `src/index.ts` | 30 | CLI entry point |
| **Total source** | **~1,200** | |
| **Total tests** | **~700** (194 tests) | |

Runtime dependencies: `@babel/parser`, `@babel/traverse`, `@babel/types`,
`@babel/generator`. Dev tooling only: TypeScript, tsx, vitest.

## Limitations

- **No string array resolution**: obfuscator.io-style string arrays with
  rotation and decoder functions are not yet handled
- **No control flow unflattening**: `while(true){switch(state){...}}`
  patterns remain as-is
- **No proxy function inlining**: wrapper functions are not detected or inlined
- **No bundler unpacking**: webpack/browserify module wrappers not extracted
- **Rename vocabulary is generic**: names like `value`, `other` are better
  than `n`, `t` but don't reflect actual semantics
- **Single-pass pipeline**: transforms run once; iterative convergence not
  yet implemented
