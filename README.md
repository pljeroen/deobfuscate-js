# deobfuscate-js

![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Tests](https://img.shields.io/badge/tests-281%20passing-green) ![Node](https://img.shields.io/badge/node-18%2B-blue) ![Architecture](https://img.shields.io/badge/AST-Babel-purple) ![Status](https://img.shields.io/badge/status-active-green)

JavaScript de-obfuscation toolkit. Reverses javascript-obfuscator transforms (string array encoding, control flow flattening, proxy function objects) and handles webpack/browserify bundles. Combines AST-based transforms with token-level formatting to produce readable output from obfuscated or minified JavaScript.

## Quick Start

```bash
npm install
npm run deobfuscate                              # input/lodash.min.js -> output/lodash.deobfuscated.js
npm run deobfuscate -- path/to/input.js out.js   # custom paths
```

## Pipeline

Two-phase architecture: AST transforms (parse once, transform N, generate once) followed by token-level formatting. The AST pipeline supports iterative convergence — passes repeat until the output stabilizes or a maximum iteration count is reached.

### AST Passes

Passes run in this order. Parses input with `@babel/parser`, applies transforms via `@babel/traverse`, generates output with `@babel/generator`.

#### Bundler Unpacking

Detects and extracts individual modules from bundled JavaScript:

- **Webpack 4** — IIFE with modules array or object, `__webpack_require__` bootstrap
- **Webpack 5** — Arrow IIFE with `__webpack_modules__` object
- **Browserify** — 3-parameter IIFE with `[function, dependencies]` tuples

Modules are extracted as named function declarations (`__module_0__`, `__module_1__`, etc.).

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

#### String Array Resolution

Resolves javascript-obfuscator's string array obfuscation pattern:

1. Detects the string array variable (array of string literals)
2. Detects optional rotation IIFE (shuffles array at load time)
3. Detects decoder function(s) (index → string lookup)
4. Executes setup code in a **process-isolated sandbox** (`child_process.execFileSync`)
5. Replaces all decoder calls with resolved string literals
6. Removes setup code (array, rotation IIFE, decoder functions)

Supports rotation with offset, base64/RC4 encoding, self-overwriting decoders, and custom decoding logic.

#### Control Flow Object Inlining

Resolves javascript-obfuscator's control flow storage objects — plain objects used as proxy dispatchers:

- Binary operations: `obj.a = function(x, y) { return x + y }` → inlines `x + y`
- Logical operations: `obj.b = function(x, y) { return x && y }` → inlines `x && y`
- Call delegation: `obj.c = function(f, ...args) { return f(...args) }` → inlines direct call
- String literals: `obj.d = "hello"` → inlines `"hello"`

Also handles the `transformObjectKeys` pattern (empty object declaration + sequential property assignments).

#### Control Flow Unflattening

Reconstructs linear control flow from javascript-obfuscator's `controlFlowFlattening` transform:

```javascript
// Before: dispatched through while/switch
var _0x = '2|0|1'.split('|'), _0xi = 0;
while (!![]) {
  switch (_0x[_0xi++]) {
    case '0': b(); continue;
    case '1': c(); continue;
    case '2': a(); continue;
  }
  break;
}

// After: linear execution in correct order
a();
b();
c();
```

Resolves the order array (pipe-delimited string or array literal), maps case labels to statement bodies, emits statements in the resolved order, and removes dispatcher variables.

#### AST Simplification

- Splits comma expression statements into separate statements
- Converts computed member access (`obj["prop"]`) to dot access (`obj.prop`) where valid

#### Semantic Variable Renaming

Renames obfuscated `_0x`-prefixed variables based on usage context:

| Context | Renamed to |
|---|---|
| For-loop counter (`for (var _0x = 0; ...)`) | `i`, `j`, `k`, ... |
| `.length` assignment (`var _0x = arr.length`) | `len` |
| Error-first callback first param | `err` |

Only renames identifiers matching the `_0x` prefix pattern. Does not touch meaningful names, globals, or non-obfuscated code.

#### Scope-Aware Renaming

Replaces remaining single-letter and two-letter minified variable names with descriptive names using Babel's scope analysis for correct lexical scoping, hoisting, and closure handling.

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

## Additional Features

### Obfuscator Fingerprinting

Analyzes an AST to identify the obfuscation tool used. Currently detects javascript-obfuscator by three patterns:

- **Hex identifiers** — prevalence of `_0x`-prefixed variable names
- **String array + decoder** — array of strings with a decoder function
- **Control flow flattening** — `while(!![])/switch` with `.split('|')` order string

Returns the identified obfuscator name, confidence score, and list of detected patterns.

### Safe/Unsafe Pass Classification

Each AST pass can declare a `safety` level (`"safe"` or `"unsafe"`). The `filterSafePasses()` utility strips unsafe passes from the pipeline. String array resolution is marked unsafe (executes code in a sandbox); all other passes are safe (pure AST transforms).

### Multi-Parser Fallback

The parser handles malformed JavaScript gracefully through a fallback chain:

1. Parse with `errorRecovery: true` (Babel stores errors in AST instead of throwing)
2. Retry with `sourceType: "script"` if module detection fails
3. Truncate to the valid prefix before the error line
4. Return empty program as last resort

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
npm test           # run all tests (281)
npm run test:watch # watch mode
```

## License

[MIT](LICENSE)
