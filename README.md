# deobfuscate-js

![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Tests](https://img.shields.io/badge/tests-893%20passing-green) ![Node](https://img.shields.io/badge/node-22%2B-blue) ![Architecture](https://img.shields.io/badge/AST-Babel-purple) ![Status](https://img.shields.io/badge/status-active-green)

JavaScript de-obfuscation toolkit. Reverses javascript-obfuscator/obfuscator.io transforms (string array encoding, control flow flattening, proxy function objects, anti-debug traps) and handles webpack/browserify bundles. Combines AST-based transforms with token-level formatting to produce readable output from obfuscated or minified JavaScript.

## Quick Start

```bash
npm install
npm run deobfuscate                              # input/lodash.min.js -> output/lodash.deobfuscated.js
npm run deobfuscate -- path/to/input.js out.js   # custom paths
npm run deobfuscate -- --unsafe path/to/input.js  # enable string-array resolution (executes code)
```

By default, only safe passes run. The `--unsafe` flag enables the string-array pass, which executes untrusted code in a V8 isolate sandbox.

> **Warning:** The `--unsafe` flag executes sample code inside a V8 isolate. This reduces host exposure but is not intended as a hardened malware sandbox. Use only on samples you trust.

### Refusals and exit status

The CLI exits with status 0 only after it has written the complete output. In each of the cases below it refuses instead: it prints one `ERROR:` line as the last line on stderr, naming the affected path and, for operating-system errors, the error code (such as `ENOENT` or `EACCES`), and exits with status 1. These refusals are decided before the output is opened, so no output is written and an existing output file keeps its contents:

- **Same file**: the output path names the same file as the input (the identical path, another spelling of it, a symlink or a hard link to it).
- **Missing, unreadable or directory input**: the input does not exist, cannot be opened (for example permission denied), or is a directory.
- **Input too large**: the input exceeds the 20MB size limit. A regular file is checked before it is read; a pipe or device is refused as soon as more than 20MB have been read from it.
- **Unparseable input**: the input cannot be parsed at all.
- **Partially parsed input**: only a prefix of the input parses. The message names the line of the syntax error; the rest of the input would be dropped silently, so the run is refused.
- **No statements left**: a non-empty input yields no statements after processing, for example a dead-code-only input such as `if (false) { x(); }`. The message names the pass that removed the last statement and the iteration in which it did so.

An input without statements is not refused: an empty or whitespace-only input produces an empty output, and a comments-only input is written with its comments, which may be kept.

Partial failures are tolerated: when a transform pass throws, its changes are undone, the pass is skipped with a `WARNING:` line naming the pass and the error, and the remaining passes still run. Parser recovery problems are reported as `WARNING:` lines too. Such a run still succeeds with exit status 0 unless one of the refusals above applies to its result.

An unexpected internal error is reported as one `ERROR: internal error: ...` line naming the input path, with exit status 1. Run again with `--verbose` to also print the stack trace (before the `ERROR:` line).

On success the `Done: ...` status line goes to stdout. When the output is the process stdout itself (for example `/dev/stdout`, or stdout redirected to the output file), the `Done:` line goes to stderr instead, so it does not end up in the output.

**Writing the output.** The output is opened without truncating it, and its identity is compared with the input again before anything is written; only then is a regular file truncated and written (devices such as `/dev/null` and pipes are written without truncation). A failure at that point (the output turned out to be the input, it is a directory, its directory does not exist, it cannot be opened) exits with status 1 with the output not modified, except that an empty output file may be left behind if it did not exist before. If an I/O error occurs after the output was truncated or writing started (for example disk full), the CLI exits with status 1 but the output file may be empty or partial. The input file is not modified in either case (within the limits of the same-file check below). On Linux, when the kernel setting `fs.protected_regular` is enabled, the operating system refuses to open an existing output file that another user owns in a shared directory with the sticky bit, such as `/tmp`, even when its permissions allow writing; the run then ends with `ERROR: Writing output failed: <out> (open: EACCES); nothing was written to the output` and the file is left unchanged. An output path that is a symlink is followed, and if its target does not exist the target is created. The exception is Linux with the kernel setting `fs.protected_symlinks` enabled: a symlink owned neither by the user running the tool nor by the owner of its directory is not followed when that directory is world-writable and has the sticky bit, such as `/tmp`; the run then ends with `ERROR: Cannot verify that output <out> is not the input file (stat: EACCES); nothing was written` and nothing is created.

**Limits of the same-file check.** The CLI compares file identity (device and inode numbers) before the pipeline runs and again when it opens the output. This relies on a filesystem with stable device/inode identity (local POSIX filesystems, NTFS). It does not cover files changed concurrently by another process while a run is in progress, and a hard link to the input may go unnoticed on filesystems that synthesize inode numbers (some FUSE or network filesystems).

**Benchmark wrapper.** `scripts/deobfuscate-js.sh` exits with status 1 without running the CLI when its input and output are the same file, and checks again before writing its fallback output. The wrapper compares file identity only (the shell `-ef` test, no path comparison), so the limits above apply, and a hard link to an input whose directory cannot be searched is not recognized. For distinct paths it behaves as before: when the CLI fails it writes an empty output file and exits 0; if that empty file cannot be created it exits with status 1.

The full behaviour, including every `ERROR:` line, is specified in [docs/SPEC-SHEET.md](docs/SPEC-SHEET.md).

## Architecture

Two-phase pipeline: AST transforms followed by token-level formatting.

- **AST phase**: Parse with `@babel/parser`, apply the transform passes via `@babel/traverse`, and generate code with `@babel/generator`. The full pass sequence repeats up to 3 times until the output stabilizes; between iterations the generated code is parsed again.
- **Token phase**: Tokenize the generated output, re-emit with proper indentation and whitespace.

All passes implement the `ASTPass` or `TokenPass` interface (defined in `src/types.ts`). The pipeline runner is in `src/pipeline.ts`. Each pass can declare a `safety` level (`"safe"` or `"unsafe"`); `filterSafePasses()` strips unsafe passes by default.

## Pipeline

The 17 AST pass steps and 1 token pass run in the order below. Some passes run more than once: constant folding and constant propagation run twice and dead code elimination three times, before and after the obfuscator-specific passes, to clean up their output. The pipeline uses fingerprint-guided pass selection to skip obfuscator-specific passes when no obfuscation patterns are detected.

| # | Pass | File | Description |
|---|---|---|---|
| 1 | Bundler Unpack | `bundler-unpack.ts` | Detect webpack 4/5 and browserify bundles, extract individual modules |
| 2 | Constant Fold | `constant-fold.ts` | Evaluate static expressions (`1+2` -> `3`, `!0` -> `true`, `void 0` -> `undefined`) |
| 3 | Constant Propagate | `constant-propagate.ts` | Inline variables assigned once to a literal, identifier alias, or constant array |
| 4 | Dead Code Eliminate | `dead-code-eliminate.ts` | Remove `if(false)` blocks, unreachable statements, unused variables/functions |
| 5 | Hex/Unicode Decode | `hex-decode.ts` | Decode `\xHH`, `\uHHHH`, `\u{HHHH}` escapes and hex numeric literals |
| 6 | String Array (Static) | `string-array-static.ts` | Resolve unencoded/base64 string arrays via static analysis (safe) |
| 7 | String Array | `string-array.ts` | Resolve string array obfuscation via V8 isolate sandbox execution (unsafe; runs only with `--unsafe`) |
| 8 | Control Flow Object | `control-flow-object.ts` | Inline control flow storage objects (proxy functions, string literals) |
| 9 | Control Flow Unflatten | `control-flow-unflatten.ts` | Reconstruct linear flow from dispatch patterns (pipe-delimited + arithmetic) |
| 10 | Constant Fold | `constant-fold.ts` | Second run -- fold expressions exposed by passes 6-9 |
| 11 | Dead Code Eliminate | `dead-code-eliminate.ts` | Second run -- remove dead code exposed by passes 6-10 |
| 12 | Anti-Debug | `anti-debug.ts` | Remove `.constructor("debugger")` traps, console overrides, self-defending guards |
| 13 | Constant Propagate | `constant-propagate.ts` | Second run -- inline constants exposed by passes 6-12 |
| 14 | Dead Code Eliminate | `dead-code-eliminate.ts` | Third run -- remove dead code exposed by passes 12-13 |
| 15 | AST Simplify | `ast-simplify.ts` | Split comma expressions into separate statements, computed to dot access |
| 16 | Semantic Rename | `semantic-rename.ts` | Rename `_0x`-prefixed variables by usage context (loop counters, arrays, JSON, regex, events) |
| 17 | Scope-Aware Rename | `ast-rename.ts` | Rename remaining single/two-letter minified names via Babel scope analysis |
| T1 | Format | `format.ts` | Token-level pretty-print with 2-space indentation and proper whitespace |

All pass source files are in `src/passes/`.

### Pass Details

#### Bundler Unpack

Detects and extracts individual modules from bundled JavaScript:

- **Webpack 4** -- IIFE with modules array or object, `__webpack_require__` bootstrap
- **Webpack 5** -- Arrow IIFE with `__webpack_modules__` object
- **Browserify** -- 3-parameter IIFE with `[function, dependencies]` tuples

Modules are extracted as named function declarations. When inter-module dependencies exist, modules are named by graph role: `__module_entry__` (bootstrap entry point), `__module_leaf_N__` (zero out-degree), `__module_util_N__` (high in-degree and out-degree). Falls back to numeric naming (`__module_N__`) when no dependency structure exists. Emits a metadata comment indicating bundle type and module count.

#### Constant Fold

Evaluates static expressions at deobfuscation time:

| Pattern | Result |
|---|---|
| `1 + 2` | `3` |
| `"hel" + "lo"` | `"hello"` |
| `!0` / `!1` | `true` / `false` |
| `void 0` | `undefined` |
| `typeof "x"` | `"string"` |
| `true && false` | `false` |

Iterates internally until no more foldable expressions remain (capped at 25 iterations).

#### Constant Propagate

Inlines variables assigned exactly once to a constant value, where the binding is never reassigned. Also propagates:

- Identifier aliases (`const alias = original` when `original` is also constant) -- scope-safe: skips references where the target name is shadowed in an inner scope
- Constant array element access (`const arr = ["a","b"]; arr[0]` -> `"a"`)
- Cross-branch `typeof` folding: when a variable is assigned the same type in both branches of an if/else, `typeof x` is folded to the type string (e.g., `"string"`, `"number"`, `"boolean"`)

#### Dead Code Eliminate

Four sub-passes in sequence:

1. Remove unreachable branches (`if(false)`, constant ternaries)
2. Remove unreachable statements after `return`/`throw`/`break`/`continue`
3. Remove unused variable declarations (when initializer has no side effects, including IIFEs)
4. Remove unreferenced nested function declarations

The `isPure` check for identifiers is restricted to `undefined`, `NaN`, and `Infinity` to avoid removing declarations with potentially side-effecting initializers.

#### Hex/Unicode Decode

Decodes `\xHH`, `\uHHHH`, and `\u{HHHH}` escape sequences in string literals back to readable characters. Also converts hex numeric literals (`0xFF`) to decimal (`255`).

#### String Array Resolution

Resolves javascript-obfuscator's string array obfuscation pattern:

1. Detects the string array variable (array of string literals or self-overwriting function)
2. Detects optional rotation IIFE (shuffles array at load time)
3. Detects decoder function(s) and wrapper functions (including function-scoped wrappers and variable aliases)
4. Extracts offset objects used in call arguments
5. Executes setup code in a **V8 isolate sandbox** (`isolated-vm`) with deterministic Date/Math.random
6. Parses sandbox output using a delimiter protocol (robust against stray stdout)
7. Replaces all decoder/wrapper calls with resolved string literals
8. Removes setup code (array, rotation IIFE, decoders, wrappers, aliases)

Supports rotation with offset, base64/RC4 encoding, self-overwriting decoders, scoped wrapper chains, and custom decoding logic. Marked `safety: "unsafe"` because it executes code.

#### Control Flow Object Inlining

Resolves javascript-obfuscator's control flow storage objects -- plain objects used as proxy dispatchers:

- Binary operations: `obj.a = function(x, y) { return x + y }` -> inlines `x + y`
- Logical operations: `obj.b = function(x, y) { return x && y }` -> inlines `x && y`
- Call delegation: `obj.c = function(f, ...args) { return f(...args) }` -> inlines direct call
- String literals: `obj.d = "hello"` -> inlines `"hello"` (including concatenation folding)

Also handles the `transformObjectKeys` pattern (empty object declaration + sequential property assignments merged before inlining). Capped at 25 iterations.

#### Control Flow Unflatten

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

Resolves the order array (pipe-delimited string or array literal), maps case labels to statement bodies, emits in resolved order, and removes dispatcher variables. Also handles arithmetic state-machine dispatchers with constant (`state = N`), additive (`state = state + C`), affine (`state = state * K + C`), and XOR (`state = state ^ C`) transitions. Capped at 25 iterations with 1000-state trace limit.

#### Anti-Debug Removal

Detects and removes obfuscator.io anti-debug patterns:

- Functions containing `.constructor("debugger")` or `.constructor("while (true) {}")`
- Console-override IIFEs that replace `console.log`/`warn`/etc with no-ops (requires both method-name array and `console[x] = ...` assignment)
- Self-defending guards that check `Function.prototype.toString()` with `(((.+)+)+)+$` regex
- `setInterval` calls that invoke anti-debug functions
- Anti-tamper IIFEs referencing removed functions
- Dead `_0x`-named function/variable declarations after removal

Convergence loops capped at 10 iterations.

#### AST Simplify

- Splits comma expression statements into separate statements
- Converts computed member access (`obj["prop"]`) to dot access (`obj.prop`) where the property name is a valid identifier and not a reserved word

#### Semantic Rename

Renames obfuscated `_0x`-prefixed variables based on usage context:

| Context | Renamed to |
|---|---|
| For-loop counter (`for (var _0x = 0; ...)`) | `i`, `j`, `k`, ... |
| `.length` assignment (`var _0x = arr.length`) | `len` |
| Error-first callback first param | `err` |
| Array method usage (`.push`, `.forEach`, `.map`) | `arr` |
| `JSON.parse()` result | `data` |
| RegExp literal or `.test()`/`.exec()` usage | `pattern` |
| Arithmetic-only usage | `num` |
| `addEventListener` callback parameter | `event` |

Only renames identifiers matching the `_0x` prefix pattern. Does not touch meaningful names, globals, or non-obfuscated code.

#### Scope-Aware Rename

Replaces remaining single-letter and two-letter minified variable names with descriptive names using Babel's scope analysis for correct lexical scoping, hoisting, and closure handling.

- Each function's bindings renamed independently via `scope.rename()`
- Conventional names preserved: `i`, `j`, `k`, `x`, `y`, `z`, `_`, `$`
- Well-known globals never renamed

#### Format (Token Phase)

Re-emits the token stream with proper indentation and whitespace. It changes only whitespace and line breaks between tokens:

- Newlines after `;`, `{`, `}`
- 2-space indentation tracking brace depth
- Spaces around binary, assignment, and ternary operators
- Keyword spacing (`if (`, `return value`, `typeof x`)
- Context-aware unary operator handling
- For-loop awareness (no line breaks inside `for(;;)`)

Before returning formatted text, the pass verifies that it is the same program as its input: the syntax trees must match under every applicable parse goal (`script` and `module`), and the ordered comments and tokens must match. If that cannot be shown, the AST-phase layout is kept. The command line tool prints `WARNING: format: output left unformatted: <reason>`, and `runPipelineWithReport()` records the same warning. `runPipeline()` and `formatPass.run()` return the unformatted text without a warning because those interfaces have no warning channel.

“Same program” does not mean identical source text. JavaScript can observe its source through facilities such as `Function.prototype.toString()` and error-stack positions, and the AST phase already changes that text.

## Stability Guarantees

- **Safe passes never execute code.** They operate purely on the AST and are always semantic-preserving.
- **Unsafe passes may skip on errors.** If sandbox execution times out, runs out of memory, or produces invalid output, the pass is skipped and the AST is returned unchanged.
- **Correctness over aggression.** The tool prefers leaving code untransformed over applying a transformation that might change runtime behavior. When in doubt, it does nothing.
- **Formatting is checked before use.** The format pass changes only whitespace and line breaks between tokens. If matching syntax trees, comments, and tokens cannot establish that its output is the same program, the AST-phase layout is kept and reporting interfaces emit `format: output left unformatted: <reason>`.

## Additional Features

### V8 Isolate Sandbox

The string array pass executes untrusted code in a **V8 isolate** (`src/sandbox.ts`) via `isolated-vm`:

- **Separate V8 heap** with 128MB memory limit (engine-enforced)
- **Wall-clock timeout** via V8 TerminateExecution (engine-enforced, 15s max)
- **No Node.js APIs** -- no require, fs, net, child_process; only 3 host-bridged callbacks
- **Deterministic** -- Date.now() frozen to constant, Math.random() seeded xorshift32 PRNG
- **DoS protected** -- output buffer 10MB cap, base64 input 1MB cap, input code 10MB cap
- **Version pinned** -- `isolated-vm` pinned to exact release (native C++ addon)

Host bridge: `__write(str)` for stdout capture, `__atob(str)` / `__btoa(str)` for base64. All callbacks are string-in/string-out with size caps.

Execution is deterministic: `Date.now()` returns a fixed constant and `Math.random()` uses a seeded PRNG. The same input always produces the same output, regardless of when or where it runs.

### Obfuscator Fingerprinting

Analyzes an AST (`src/fingerprint.ts`) to identify the obfuscation tool used. Currently detects javascript-obfuscator by three patterns:

- **Hex identifiers** -- prevalence of `_0x`-prefixed variable names
- **String array + decoder** -- array of strings with a decoder function
- **Control flow flattening** -- `while(!![])/switch` with `.split('|')` order string

Returns the identified obfuscator name, confidence score, and list of detected patterns. The fingerprint result drives pass selection: obfuscator-specific passes (string-array, control-flow-object, control-flow-unflatten, anti-debug) are skipped when no obfuscation patterns are detected, reducing processing time for minified-but-not-obfuscated JavaScript.

### Pipeline Context & Entropy Tracking

Passes share metadata through a `PipelineContext` object threaded through the pipeline. Currently carries:

- **Fingerprint result** -- obfuscator detection used for pass selection
- **Arbitrary metadata** -- passes can write/read typed data for cross-pass communication

Shannon entropy of identifier names is computed at pipeline start and end, measuring deobfuscation progress. Higher entropy indicates more random/obfuscated names; entropy decreases as rename passes produce readable identifiers. Visible via `--verbose` flag.

### Multi-Parser Fallback

The parser (`src/parser.ts`) handles malformed JavaScript gracefully through a fallback chain:

1. Parse with `errorRecovery: true` (Babel stores errors in AST instead of throwing)
2. Retry with `sourceType: "script"` if module detection fails
3. Truncate to the valid prefix before the error line
4. Return empty program as last resort

Also provides `parseWithDiagnostics()` returning `{ ast, warnings }` plus a structured outcome (`completeness`, `mode`, `recoveredErrors`, `truncatedAtLine`). The CLI refuses inputs whose parse needed the truncation or empty-program fallback (see [docs/SPEC-SHEET.md](docs/SPEC-SHEET.md)).

### Structured Pipeline Output

`runPipelineWithReport()` returns `{ code, warnings, report }` with per-pass changed flags, plus the input's parse outcome and statement counts; it skips a throwing pass with a warning. The result also carries the statement counts before and after each pass invocation and, when a non-empty input ends without statements, the pass that removed the last statement. The original `runPipeline()` is kept for backward compatibility (there a throwing pass still propagates).

## Results

### JsDeObsBench Benchmark

Evaluated on [JsDeObsBench](https://github.com/Ch3nYe/JsDeObsBench) (9,000+ obfuscated JavaScript samples across 7 transformations + combinations). Overall score is the mean of syntax validity, execution correctness, Halstead length reduction, and CodeBLEU similarity to the original source.

| Tool | Type | Single | Combination | Combined |
|---|---|---|---|---|
| deobfuscate-js | Expert | 76.11 | 86.26 | 81.18 |
| webcrack | Expert | 73.99 | 85.68 | 79.84 |
| GPT-4o | LLM | 73.67 | 41.68 | 57.67 |

Per-transformation breakdown (single):

| Transformation | Syntax | Exe | Decomplex | CodeBLEU | Overall |
|---|---|---|---|---|---|
| code-compact | 100.0 | 100.0 | 1.1 | 70.2 | 67.8 |
| control-flow-flattening | 100.0 | 100.0 | 26.6 | 70.4 | 74.3 |
| deadcode-injection | 100.0 | 100.0 | 49.1 | 68.8 | 79.5 |
| debug-protection | 100.0 | 100.0 | 65.8 | 70.1 | 84.0 |
| name-obfuscation | 100.0 | 100.0 | 1.2 | 52.9 | 63.5 |
| self-defending | 100.0 | 100.0 | 47.3 | 69.8 | 79.3 |
| string-obfuscation | 100.0 | 100.0 | 69.2 | 68.5 | 84.4 |

100% syntax validity and 100% execution correctness across all transformations.

### Minified JavaScript

Tested on `lodash.min.js` v4.17.23:

| Metric | Input | Output | Change |
|---|---|---|---|
| Lines | 139 | 2,612 | 19x |
| Bytes | 73,320 | 111,643 | 1.5x |
| Boolean idioms (`!0`, `!1`) | 113 | 0 | -100% |

Output passes `node --check` -- syntactically valid JavaScript.

## Testing

```bash
npm test           # run all tests (740)
npm run test:watch # watch mode
```

## License

[MIT](LICENSE)
