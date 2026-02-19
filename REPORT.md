# JavaScript De-obfuscation Report

## Benchmark 1: Minified Code

**Target**: `lodash.min.js` v4.17.23 (73,320 bytes, 139 lines)

| Metric | Input | Output | Change |
|---|---|---|---|
| Lines | 139 | 2,355 | 17x |
| Bytes | 73,320 | 160,729 | 2.2x |
| Single-letter identifiers | 8,769 (51%) | 759 (4%) | -91% |
| Boolean idioms (`!0`, `!1`) | 113 | 0 | -100% |
| Hex escapes (`\xNN`) | 98 | 128 | +31% |

Output passes `node --check` — syntactically valid JavaScript.

**Assessment**: Effective on minified code. Constant folding, dead code
elimination, scope-aware renaming, and formatting all activate. The
structural deobfuscation passes (string array, CFF, bundler, proxy
objects) do not trigger — lodash is minified, not obfuscated.

## Benchmark 2: Obfuscated Code

**Target**: 77-line shopping cart implementation (2,051 bytes) obfuscated
with `javascript-obfuscator` at maximum settings:

- `stringArray: true` + `stringArrayEncoding: 'base64'` + `stringArrayWrappersCount: 5` + `stringArrayWrappersType: 'function'`
- `controlFlowFlattening: true` (threshold 1.0)
- `deadCodeInjection: true` (threshold 1.0)
- `transformObjectKeys: true`
- `splitStrings: true` (chunk length 5)
- `identifierNamesGenerator: 'hexadecimal'`
- `unicodeEscapeSequence: true`
- `numbersToExpressions: true`

| Metric | Clear | Obfuscated | Deobfuscated | Recovery |
|---|---|---|---|---|
| Bytes | 2,051 | 41,009 | 35,141 | -14% (from obfuscated) |
| Lines | 77 | 0 (single line) | 857 | Formatting + cleanup |
| `_0x` identifiers | 0 | 2,555 | 1,649 | -35% |
| Unique `_0x` names | 0 | 800 | 648 | -19% |
| `a0_0x` decoder calls | 0 | 687 | 30 | -96% |
| Hex numeric literals | 0 | 801 | 550 | -31% |
| Readable strings recovered | — | — | 21 unique | Substantial |
| Method names recovered | 0/6 | — | 6/6 | 100% |

Output passes `node --check` — syntactically valid JavaScript.
`ShoppingCart` function name preserved (not renamed by obfuscator config).

**Assessment**: Partially effective. The string array pass now resolves
top-level decoder/wrapper calls (687 → 30, -96%), recovering method names
(`addItem`, `removeItem`, `setDiscount`, `getSubtotal`, `getTotal`,
`checkout`), string arguments (`"Laptop"`, `"Mouse"`, `"Keyboard"`), and
class structure (`ShoppingCart.prototype.addItem = function(...)`).
Iterative convergence folds split strings and simplifies member access.
The file shrank 14% from the obfuscated size.

### What works

**String array resolution** detects self-overwriting array functions,
wrapper decoder functions with offset arithmetic, and rotation IIFEs.
Top-level calls to wrappers are resolved via sandbox execution. Iterative
convergence then applies constant folding to merge split strings
(`"proto" + "type"` → `"prototype"`) and simplifies computed member access
(`obj["method"]` → `obj.method`).

### What remains unresolved

**Calls inside function bodies**: 30 decoder wrapper calls remain inside
user functions (e.g., `ShoppingCart.prototype.addItem`). These use local
offset objects that are scoped inside the function body — the sandbox
cannot resolve them without per-scope analysis.

**Control flow flattening inside functions**: The `while(!![])/switch`
dispatch pattern exists inside function bodies but uses the unresolved
wrapper calls for case ordering. String resolution must happen first.

**Dead code from `deadCodeInjection`**: Unreachable code blocks survive
because their predicates depend on still-unresolved wrapper calls.

**Numeric expressions**: `numbersToExpressions` converts prices like
`999.99` to `0x420 + -0x11 * 0x89 + 0x8e0 + 0.99`. Mixed integer/float
arithmetic prevents pure constant folding.

## Pipeline

Two-phase architecture: AST transforms (parse once, transform N, generate
once) followed by token-level formatting. The AST pipeline supports
iterative convergence — passes repeat until output stabilizes or a maximum
iteration count is reached.

### Phase 1: AST Transforms (11 passes)

Parses source with `@babel/parser` (with error recovery and multi-parser
fallback), applies eleven transforms via `@babel/traverse`, generates
output with `@babel/generator`.

| # | Pass | Function | Minified | Obfuscated |
|---|---|---|---|---|
| 1 | Bundler unpacking | Extract modules from webpack 4/5, browserify | No | No |
| 2 | Constant folding | `1+2` → `3`, `!0` → `true`, `void 0` → `undefined` | Yes | Yes (iter 2+) |
| 3 | Constant propagation | Inline single-assignment const/var with literal values | Yes | No |
| 4 | Dead code elimination | Remove `if(false)`, unreachable code, unused variables | Yes | Partial |
| 5 | Hex/unicode decoding | `\x48\x65\x6c\x6c\x6f` → `Hello` | Yes | Yes |
| 6 | String array resolution | Resolve string array + rotation + decoder + wrappers (sandboxed) | No | **Yes (-96%)** |
| 7 | Control flow object inlining | Inline proxy function objects and string mappings | No | No |
| 8 | Control flow unflattening | Reconstruct linear flow from while/switch dispatch | No | No |
| 9 | AST simplification | Split comma expressions, `obj["prop"]` → `obj.prop` | Yes | Yes (iter 2+) |
| 10 | Semantic renaming | `_0x`-prefixed variables → context-aware names | No | No |
| 11 | Scope-aware renaming | Single/two-letter variables → descriptive vocabulary | Yes | No |

### Phase 2: Token-Level Formatting

Custom tokenizer + format pass for indentation, line breaks, operator
spacing, keyword spacing, and context-aware unary handling. This is the
only pass that had meaningful effect on the obfuscated sample.

### Additional Capabilities

| Feature | Function |
|---|---|
| Obfuscator fingerprinting | Detect javascript-obfuscator by hex identifiers, string arrays, CFF |
| Safe/unsafe classification | Filter passes by safety level; sandbox-dependent passes marked unsafe |
| Multi-parser fallback | Error recovery → script mode → line truncation → empty program |
| Iterative convergence | Repeat pass pipeline until fixpoint or max iterations |

## Tooling

| Component | Lines | Purpose |
|---|---|---|
| `src/passes/format.ts` | 309 | Token-level pretty-printer |
| `src/passes/control-flow-object.ts` | 307 | Proxy function object inlining |
| `src/passes/rename.ts` | 304 | Token-level rename (legacy) |
| `src/passes/string-array.ts` | 403 | String array + decoder + wrapper resolution |
| `src/passes/simplify.ts` | 273 | Token-level simplification (legacy) |
| `src/passes/bundler-unpack.ts` | 256 | Webpack/browserify module extraction |
| `src/tokenizer.ts` | 244 | From-scratch JS lexer |
| `src/passes/control-flow-unflatten.ts` | 224 | While/switch dispatch reconstruction |
| `src/passes/constant-fold.ts` | 194 | Static expression evaluation |
| `src/passes/dead-code-eliminate.ts` | 150 | Unreachable code removal |
| `src/fingerprint.ts` | 149 | Obfuscator pattern detection |
| `src/passes/semantic-rename.ts` | 146 | Context-aware variable renaming |
| `src/passes/ast-rename.ts` | 82 | Babel scope-aware renaming |
| `src/pipeline.ts` | 68 | Dual-mode pipeline with convergence |
| `src/passes/ast-simplify.ts` | 61 | Comma splitting, member access |
| `src/passes/constant-propagate.ts` | 60 | Single-assignment inlining |
| `src/parser.ts` | 59 | Parse/generate with fallback chain |
| `src/types.ts` | 55 | Token types, pass interfaces |
| `src/passes/hex-decode.ts` | 41 | String escape decoding |
| `src/index.ts` | 37 | CLI entry point |
| `src/sandbox.ts` | 28 | Process-isolated code execution |
| `src/babel.ts` | 15 | Babel ESM/CJS interop |
| **Total source** | **3,465** | **22 files** |
| **Total tests** | **2,652** | **289 tests across 20 files** |

Runtime dependencies: `@babel/parser`, `@babel/traverse`, `@babel/types`,
`@babel/generator`. Dev tooling only: TypeScript, tsx, vitest.

## Limitations

### Critical

- **Function-scoped wrapper calls unresolved**: 30 of 687 decoder wrapper
  calls (4%) remain inside function bodies. These use local offset objects
  scoped to the function — the sandbox cannot resolve them without
  per-scope analysis. This blocks further deobfuscation inside function
  bodies (control flow unflattening, dead code removal).
- **No dead code injection removal**: javascript-obfuscator's
  `deadCodeInjection` adds unreachable code blocks that survive because
  their predicates depend on unresolved wrapper calls inside function
  bodies.

### Moderate

- **Vocabulary rename is generic for minified code**: the scope-aware
  rename pass assigns names from a fixed vocabulary (`value`, `other`,
  `var207`). Semantic renaming only activates on `_0x`-prefixed identifiers
  in specific patterns (loop counters, `.length`, error callbacks).
- **Hex escapes can increase**: Babel's code generator may introduce
  `\xNN` escapes not present in the original source. The hex decode pass
  runs before generation, so escapes added during generation are not caught.
- **Mixed numeric expressions not folded**: `numbersToExpressions`
  generates `0x420 + -0x11 * 0x89 + 0x8e0 + 0.99` which mixes integer
  hex and floating-point literals. The constant fold pass handles pure
  integer or pure string expressions but not mixed-type arithmetic.
- **Fingerprinting limited to javascript-obfuscator**: JScrambler,
  Closure Compiler advanced mode, and other obfuscation tools are not
  detected.

### Low

- **No eval/Function constructor handling**: dynamically constructed code
  via `eval()` or `new Function()` is not analyzed or deobfuscated.
- **No source map generation**: the output has no mapping back to the
  original source.
