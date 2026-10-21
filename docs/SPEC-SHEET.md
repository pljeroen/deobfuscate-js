# deobfuscate-js Specification Sheet

This sheet describes the observable behaviour of the `deobfuscate-js` command line tool and its benchmark wrapper script, which are the product. Section 9 is a reference to the internal modules behind the command line tool (the safe file access module and the pipeline/parser result types).

## 1. Command line

```bash
npm run deobfuscate -- [--unsafe] [--verbose] [INPUT [OUTPUT]]
# or directly
npx tsx src/index.ts [--unsafe] [--verbose] [INPUT [OUTPUT]]
```

| Argument | Meaning | Default |
|---|---|---|
| `INPUT` | File to read | `input/lodash.min.js`, resolved against the current directory |
| `OUTPUT` | File to write | `output/lodash.deobfuscated.js`, resolved against the current directory |
| `--unsafe` | Also run the string-array pass, which executes sample code in a V8 isolate | off |
| `--verbose` | Print a per-pass report to stderr (and the stack trace of an internal error) | off |

Any other argument that starts with `--` is ignored, as are positional arguments after the second. Paths are reported in messages exactly as given (or as the resolved default).

Accepted inputs: regular files, FIFOs and character devices such as `/dev/null`. An input without statements is not refused: an empty or whitespace-only input produces an empty output, and a comments-only input is written with its comments, which may be kept.

Accepted outputs: a new or existing regular file, and devices or pipes such as `/dev/null` and `/dev/stdout` (the latter when stdout is a file, pipe or terminal; a socket cannot be opened by path). A directory output is refused. An output path that is a symlink is followed, and if its target does not exist the target is created (when the target's directory does not exist or cannot be written, the open is refused as described in section 4). On Linux, when the kernel setting `fs.protected_regular` is enabled, the operating system refuses to open an existing output file in a shared world-writable directory with the sticky bit, such as `/tmp`, when that file is owned neither by the user running the tool nor by the directory's owner, even when its permissions allow writing (with the setting `2` also in group-writable sticky directories; `fs.protected_fifos` does the same for a FIFO). The run then ends with `ERROR: Writing output failed: <out> (open: EACCES); nothing was written to the output` and the file is left unchanged. Likewise on Linux with `fs.protected_symlinks` enabled, a symlink owned neither by that user nor by the owner of its directory is not followed when that directory is world-writable and has the sticky bit; the run then ends with `ERROR: Cannot verify that output <out> is not the input file (stat: EACCES); nothing was written` (the output identity refusal in section 4) and nothing is created.

## 2. Exit status

| Status | Meaning |
|---|---|
| `0` | The complete output was written. |
| `1` | The run was refused or failed. Exactly one `ERROR:` line is printed, and it is the last line on stderr. |

The status is set without terminating the process early, so all stderr output is delivered, also through a pipe. A process that is killed (for example by a signal or by running out of memory) ends with a different status and without an `ERROR:` line.

## 3. Processing order

1. The input is opened once, read-only. Its identity (device and inode number), type and size are taken from that open file, so replacing the input path afterwards does not change what is read.
2. The output path is checked against the input's identity (same-file check).
3. A directory input is refused.
4. The input is read through the open file, up to the 20MB size limit.
5. The bytes are decoded as UTF-8 once, after the full read, and the transform pipeline runs.
6. The parse and empty-result refusals are applied.
7. The output is opened, checked against the input's identity again, and written.

The first applicable refusal ends the run. A same-file refusal therefore takes precedence over every other outcome, including an empty or directory input; a missing input is reported as a missing input, never as a same-file case.

## 4. Refusals

`<in>` and `<out>` stand for the input and output paths as given; `<CODE>` is the operating-system error code (for example `ENOENT`, `EACCES`, `EISDIR`, `ENOTDIR`, `ELOOP`, `ENOSPC`, `EIO`).

| Condition | ERROR line | Output |
|---|---|---|
| Input cannot be opened, or its open file cannot be stat'ed | `ERROR: Cannot read input file <in>: not found (ENOENT)`; `permission denied (EACCES)` or `(EPERM)`; other codes `<operation> error (<CODE>)` with `open` or `fstat` as the operation | not opened |
| Same file (identical path, other spelling, symlink, symlink chain, hard link) | `ERROR: Input and output are the same file: input <in>, output <out>; nothing was written` | not opened |
| Output identity cannot be established (any stat error other than "does not exist", e.g. a path under a regular file or a symlink loop) | `ERROR: Cannot verify that output <out> is not the input file (stat: <CODE>); nothing was written`; when a filesystem reports inode 0 and a real path cannot be resolved, `(realpath: <CODE>)`, naming the input path too when it is the input's real path that failed | not opened |
| Input is a directory | `ERROR: Cannot read input file <in>: is a directory (EISDIR)` | not opened |
| Input larger than 20MB | `ERROR: Input file exceeds max size: <in>: <N> bytes (max: 20971520 bytes / 20MB)` for a regular file (checked before reading); `... <in>: more than 20971520 bytes read (max: ...)` for a pipe, device or growing file | not opened |
| Read error | `ERROR: Cannot read input file <in>: read error (<CODE>)` (codes listed in the first row use their reason text instead) | not opened |
| Input cannot be parsed at all | `ERROR: Input could not be parsed: <in> (syntax error at line N); nothing was written` (the line part appears when the error line is known) | not opened |
| Only a prefix of the input parses | `ERROR: Input was only partially parsed: <in> (syntax error at line N); nothing was written` | not opened |
| An input with at least one statement or directive ends with none (for example dead-code-only input such as `if (false) { x(); }`) | `ERROR: All statements were removed from the non-empty input <in> by the <pass> pass (iteration <i>); nothing was written`, where `<pass>` is the last pass after which the program had no statements, in an iteration that was kept, and `<i>` is that iteration (counted from 1); when no pass did so, `ERROR: All statements were removed from the non-empty input <in>; nothing was written` | not opened |
| Same file found when opening the output | `ERROR: Input and output are the same file (found when opening the output): input <in>, output <out>; nothing was written` | opened, not written |
| Identity of the opened output cannot be read, or (inode 0) a real path cannot be resolved | `ERROR: Cannot verify that output <out> is not the input file (fstat: <CODE>); nothing was written`, or `(realpath: <CODE>)` | opened, not written |
| Output cannot be opened, truncated or written before any data reached it (directory, missing directory, permission, a write that makes no progress) | `ERROR: Writing output failed: <out> (<operation>: <CODE>); nothing was written to the output` (a write that makes no progress reads `(write: zero progress)`) | not written |
| Truncate, write or close error after the output was truncated or the first data written (for example disk full) | `ERROR: Writing output failed: <out> (<operation>: <CODE>); the output may be empty or partial` | may be empty or partial |
| Unexpected internal error | `ERROR: internal error: <in>: [<CODE>: ]<message>`, the message on one line | see below |

Rules for the output path on a refusal:

- Every refusal above the "Same file found when opening the output" row is decided before the output is opened: an absent output stays absent and an existing output keeps its bytes.
- A refusal decided after the output was opened but before any data was written leaves an existing output byte-identical; an output that did not exist may be left as an empty file.
- After the output was truncated or the first data written, a failure may leave the output empty or partial. The input is not affected (within the limits of section 7), so re-running after fixing the cause (for example freeing disk space) can produce the output.
- An internal error raised before the output is opened writes nothing; one raised while writing follows the two rules above.

No refusal prints a `Done:` line.

## 5. Streams

stderr carries, in this order:

1. the `--unsafe` notice: `WARNING: Unsafe mode enabled — string-array pass will execute untrusted code` (only with `--unsafe`);
2. pipeline warnings, one `WARNING: <text>` line each (only when the pipeline ran);
3. the `--verbose` report: an empty line, `Pipeline: <n> iteration(s), entropy <a> → <b>`, `Pass report:`, then one line per pass invocation: `  <pass>: changed (iteration <i>, statements <s> → <t>)` or `  <pass>: no change (iteration <i>, statements <s> → <t>)` for an AST pass, where `<i>` is the iteration (counted from 1) and `<s>` and `<t>` are the top-level statements plus directives of the program before and after the invocation (for a pass whose changes were undone, `<t>` equals `<s>`), and `  <pass>: changed` or `  <pass>: no change` for the format pass (only with `--verbose` and when the pipeline returned a result); for an internal error with `--verbose`, the stack frame lines (`    at ...`) of the error follow;
4. the `ERROR:` line, on a refusal only.

On success, `Done: <in> (<bytes> bytes) → <out> (<bytes> bytes)` is printed to stdout after all stderr output. When the output is the process's own stdout (the opened output has the same device and inode as file descriptor 1, for example `/dev/stdout` or stdout redirected to the output file), the `Done:` line is printed to stderr as its last line instead, so it does not end up in the output.

Pipeline warnings:

| Warning | Meaning |
|---|---|
| `WARNING: <pass>: <message>` | The pass threw; its changes were undone and the remaining passes ran. |
| `WARNING: format: output left unformatted: the formatted text is not the same program as its input` | Formatting was skipped because the formatted candidate did not preserve the input syntax tree, comments and tokens under every applicable parse goal. The AST-phase code is kept and the run continues with exit status 0. |
| `WARNING: format: output left unformatted: the input does not parse as a program without errors` | Formatting was skipped because the AST-phase code does not parse without errors as either a script or a module. The AST-phase code is kept and the run continues with exit status 0. |
| `WARNING: Parse error (recovered): <message>` | The parser recovered from an error. |
| `WARNING: Fell back to sourceType 'script' after module parse failure` | The input was parsed as a script. |
| `WARNING: Discarded iteration <n>: <condition>; kept the state from before that iteration` | Generating or re-parsing the code of an iteration failed, or the re-parse was worse than the parse of the input (see section 6); processing continued from the state before that iteration. |

Parse-fallback warnings such as `Truncated at line N: ...` and `Could not parse source; returned empty program` accompany the parse refusals.

## 6. Transform pipeline

- **Pass failures.** When an AST pass or a token pass (including the format pass) throws, the state it received (program tree, pipeline context, source text) is restored, a warning names the pass and the error, its report entry shows `changed: false`, and the remaining passes run. For passes whose behaviour depends only on their input, the output code then equals that of the same run with that invocation left out. A run with skipped passes still exits 0 unless a refusal applies to its result.
- **Iterations.** The pass sequence repeats up to 3 times until the output stabilises. After the first and second iteration the generated code is parsed again. Such an iteration is discarded, processing continues from the state before it, and no further iteration runs, when generating its code throws, when its re-parse throws, when the re-parse is less complete than the parse of the input (whole, then partial, then empty), or when the re-parse recovers from more errors than the parse of the input. A re-parse that is as good as the input's parse is accepted, so an input that already contains a recoverable error is still transformed. On the last iteration no re-parse follows; an error while generating its code is an internal error.
- **Other errors.** An error outside a pass and outside the iteration checks above (for example while generating code to compare a pass's effect, or while computing statistics) ends the run as an internal error.

## 7. Limits of the same-file check

- Identity is compared by device and inode number before the pipeline and again when the output is opened. This relies on a filesystem with stable device/inode identity (local POSIX filesystems, NTFS). When a filesystem reports inode 0, the canonical real paths are compared instead; any failure to resolve the input's real path, and any failure other than "does not exist" for the output's, refuses the run.
- Changes made concurrently by another process while a run is in progress (for example replacing the output after it was opened) are not covered.
- A hard link to the input may go unnoticed on filesystems that synthesize inode numbers (some FUSE or network filesystems).

## 8. Benchmark wrapper `scripts/deobfuscate-js.sh`

```bash
scripts/deobfuscate-js.sh INPUT OUTPUT
```

- If INPUT and OUTPUT are the same file (the shell `-ef` test: same device and inode, so symlinks and hard links count), it prints `ERROR: input and output are the same file: INPUT=<in> OUTPUT=<out>; nothing was written` to stderr and exits 1 without running the tool. A path that does not exist is never the same file.
- Otherwise it runs the tool with `--unsafe`, a 60 second timeout and stderr discarded.
- If the tool failed or left no regular output file, it checks again for the same-file case (exit 1, same message), then creates an empty output file. If that cannot be done it prints `ERROR: could not create the empty output file: OUTPUT=<out>` (after the shell's own error message) and exits 1.
- Otherwise it exits 0.

The wrapper compares file identity only, with the limits of section 7. A hard link to an input whose directory cannot be searched is not recognized, because the identity of such an input cannot be read.

## 9. Internal modules

The modules in this section are internal to the command line tool and are documented for contributors. They are not a supported interface and may change without notice.

### `src/cli/safe-output.ts`

Operating-system errors (errors carrying an error code) are returned as values, not thrown: `openInput`, `readInput` and `guardedWrite` return `Result<T> = { ok: true, value: T } | { ok: false, error: SafeFailure }`, `statTarget` returns a `StatTarget` and `identityDecision` an `IdentityResult`. `closeInput` returns nothing and ignores close errors. An error thrown by a file operation without an error code propagates from every function. Every function accepts an optional `ops` object replacing any of the file operations (`openSync`, `fstatSync`, `statSync`, `readSync`, `ftruncateSync`, `writeSync`, `closeSync`, `realpathSync`, and `fstatStdout` for the stat of file descriptor 1); missing entries default to `node:fs`.

| Export | Description |
|---|---|
| `MAX_INPUT_BYTES` | `20 * 1024 * 1024`, the input size limit. |
| `openInput(inputPath, { ops?, hooks?: { afterInputOpen? } })` | Opens the input read-only once and stats the open file. Returns `InputHandle { fd, id: { dev, ino }, kind, size, path }` with `kind` one of `"regular"`, `"fifo"`, `"chardev"`, `"directory"`, `"other"` and `dev`, `ino`, `size` as `bigint`; or a failure with reason `INPUT` and the code. |
| `readInput(handle, { maxBytes?, ops? })` | Reads all bytes through the handle (no decoding). A regular file larger than `maxBytes` (default `MAX_INPUT_BYTES`) fails with reason `SIZE` before any read; otherwise reading stops with `SIZE` as soon as the total exceeds the limit. A read error fails with `INPUT` and the code. |
| `closeInput(handle, { ops? })` | Closes the input descriptor and returns nothing. A close error carrying an error code is deliberately ignored: the descriptor is read-only, so no data can be lost. |
| `statTarget(path, { ops? })` | Stats a path, following symlinks: `{ ok: true, dev, ino }` or `{ ok: false, code }`. |
| `identityDecision(idIn, target, inputPath, outputPath, { ops? })` | Returns `{ decision, code?, side? }` with `decision` one of `"Same"`, `"Distinct"`, `"Absent"` (the target does not exist) or `"Unknown"` (any other stat error, or a real-path error in the inode-0 case). `dev` and `ino` are compared as exact `bigint` values; real paths are compared only when either inode is 0. |
| `guardedWrite(outputPath, data, idIn, inputPath, { ops?, hooks?: { beforeOutputOpen? } })` | Writes `data` through one checked descriptor: exclusive create, or (if the path exists) one write-only re-open without truncation, which creates the file when the path is a symlink to a missing file (or the path was removed after the exclusive create failed); stat of the open file; identity check against `idIn`; truncation only for a regular file; writes until every byte is written; close. Returns `WriteSuccess { outputId, doneToStderr }`, where `doneToStderr` is true when file descriptor 1 has the identity of the output. Failures carry reason `WRITE`, `SAME` or `IDUNK` and stage `WPRE` (no data written yet) or `WPOST` (after the first truncation or write). |

`SafeFailure` fields: `reason` (`INPUT`, `SAME`, `IDUNK`, `SIZE`, `WRITE`), `stage` (`PRE`, `WPRE`, `WPOST`), `path` (as given), and when applicable `code`, `op` (the failing operation), `detail` (for example `zero progress`) and `side` (`input` or `output`).

Exported types: `Result`, `SafeFailure`, `FailureReason`, `FailureStage`, `FileId`, `FileKind`, `InputHandle`, `StatTarget` (result of `statTarget`), `IdentityResult` (result of `identityDecision`), `WriteSuccess`, `FsOps` (the replaceable file operations) and `OpsOption` (`{ ops?: Partial<FsOps> }`).

The module never renames, deletes or creates temporary files, and never opens a file with truncation or for reading and writing at once.

### `src/parser.ts`

`parseWithDiagnostics(source)` returns `ParseResult { ast, warnings, completeness, mode, recoveredErrors, truncatedAtLine? }`:

| Field | Values |
|---|---|
| `completeness` | `"whole"` (the whole input is represented, including error recovery and the script fallback), `"truncated"` (only the prefix before the error line was parsed), `"empty"` (nothing could be parsed) |
| `mode` | `"module-capable"` or `"script-fallback"` |
| `recoveredErrors` | Number of errors the parser recovered from in the returned tree |
| `truncatedAtLine` | Line of the syntax error whenever the truncation fallback ran, also when it ended in an empty program |

The types `ParseCompleteness`, `ParseMode` and `ParseOutcome` (the four outcome fields) are exported. `parse()` and `generate()` are unchanged.

### `src/pipeline.ts`

`runPipelineWithReport(source, astPasses, tokenPasses)` returns `PipelineResult { code, warnings, report, iterations, initialEntropy, finalEntropy, initialParse, inputStatementCount, finalStatementCount, passStatementCounts, emptiedBy? }`, where `initialParse` is the `ParseOutcome` of the input, and the two counts are statements plus directives of the input program and of the program that produced `code`. `passStatementCounts` holds one `PassStatementCount { name, iteration, before, after }` per AST pass invocation, in the order of `report` (whose first entries they are): the statements plus directives before and after the invocation (for an invocation that threw, of the restored program). `emptiedBy` (`{ name, iteration }`) is present only when a non-empty input ends without statements and an AST pass invocation in an iteration that was kept took the program to none; it names the last such invocation. The type `PassStatementCount` is exported; `report` entries keep exactly `{ name, changed }`. Pass failures and degraded iterations are handled as described in section 6. Any other error (including one on the last iteration's code generation) is rethrown; the warnings collected until then can be read from the thrown value with `warningsOf(thrown)` (an object is rethrown as itself when the warnings can be attached to it; otherwise, and for a non-object value, an `Error` whose message is the string form of the thrown value is thrown instead, with the original as its `cause`).

On an expected format fallback, `formatPass.run`, `runPipeline` and `runTokenPipeline` return the unformatted AST-phase text without a warning because they have no warning channel. `runPipelineWithReport` returns the same text, adds `format: output left unformatted: <reason>` to `warnings`, and records the format pass as unchanged.

`runPipeline`, `runASTPipeline`, `runTokenPipeline` and `filterSafePasses` are unchanged; in `runPipeline` and `runASTPipeline` a throwing pass still propagates.
