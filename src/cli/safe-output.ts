/**
 * Safe file access for the CLI: the single input descriptor with its bounded
 * read, the file-identity decision, and the guarded output write.
 *
 * Every function returns a result value. A Node fs error that carries an OS
 * error code becomes a Failure; anything else is unexpected and propagates.
 * The fs operations and two hooks are parameters with node:fs defaults, so the
 * race windows (input path replaced after the open, output path swapped before
 * the output open) can be exercised deterministically.
 *
 * Identity is (dev, ino) compared as exact BigInt values. Only when either side
 * reports ino 0 (identity unavailable) are canonical real paths compared.
 */

import { openSync, fstatSync, statSync, readSync, ftruncateSync, writeSync, closeSync, realpathSync, constants } from "node:fs";
import type { BigIntStats } from "node:fs";

/** Cap on the bytes read from the input (20MB). */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** First read size; a regular file is sized from its fstat instead. */
const READ_CHUNK_BYTES = 64 * 1024;

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL } = constants;

export type FailureReason = "INPUT" | "SAME" | "IDUNK" | "SIZE" | "WRITE";

/** PRE: before the pipeline; WPRE: write stage, output not yet modified; WPOST: write stage, output modified. */
export type FailureStage = "PRE" | "WPRE" | "WPOST";

export interface SafeFailure {
  readonly reason: FailureReason;
  readonly stage: FailureStage;
  /** The affected path as given by the caller. */
  readonly path: string;
  /** Node error code when an OS error is involved. */
  readonly code?: string;
  /** The fs operation that failed (open, fstat, read, ftruncate, write, close, realpath). */
  readonly op?: string;
  /** Additional description, e.g. "zero progress" for a write that wrote nothing. */
  readonly detail?: string;
  /** For an identity failure: which side's path could not be resolved. */
  readonly side?: "input" | "output";
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SafeFailure };

export interface FileId {
  readonly dev: bigint;
  readonly ino: bigint;
}

export type FileKind = "regular" | "fifo" | "chardev" | "directory" | "other";

export interface InputHandle {
  readonly fd: number;
  readonly id: FileId;
  readonly kind: FileKind;
  readonly size: bigint;
  readonly path: string;
}

/** Result of stat on a path: its identity, or the OS error code. */
export type StatTarget = { readonly ok: true; readonly dev: bigint; readonly ino: bigint } | { readonly ok: false; readonly code: string };

export interface IdentityResult {
  readonly decision: "Same" | "Distinct" | "Absent" | "Unknown";
  readonly code?: string;
  readonly side?: "input" | "output";
}

export interface WriteSuccess {
  /** Identity of the verified output descriptor. */
  readonly outputId: FileId;
  /** True when fd 1 is the output itself, so a status line must not go to stdout. */
  readonly doneToStderr: boolean;
}

/** The fs operations used by this module (node:fs positional signatures). */
export interface FsOps {
  openSync(path: string, flags: number, mode?: number): number;
  fstatSync(fd: number, options: { bigint: true }): BigIntStats;
  statSync(path: string, options: { bigint: true }): BigIntStats;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: null): number;
  ftruncateSync(fd: number, len: number): void;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  closeSync(fd: number): void;
  realpathSync(path: string): string;
  /** fstat of fd 1. */
  fstatStdout(): BigIntStats;
}

export interface OpsOption {
  ops?: Partial<FsOps>;
}

const NODE_OPS: FsOps = {
  openSync,
  fstatSync,
  statSync,
  readSync,
  ftruncateSync,
  writeSync,
  closeSync,
  realpathSync,
  fstatStdout: () => fstatSync(1, { bigint: true }),
};

function withDefaults(ops: Partial<FsOps> | undefined): FsOps {
  return { ...NODE_OPS, ...ops };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; code: string };

/** Run one fs operation: an OS error (an error carrying a string code) becomes data, anything else propagates. */
function attempt<T>(operation: () => T): Attempt<T> {
  try {
    return { ok: true, value: operation() };
  } catch (e: unknown) {
    const code = errorCode(e);
    if (code === undefined) throw e;
    return { ok: false, code };
  }
}

function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function success<T>(value: T): Result<T> {
  return Object.freeze({ ok: true as const, value });
}

function failure<T>(error: SafeFailure): Result<T> {
  return Object.freeze({ ok: false as const, error: Object.freeze(error) });
}

function idOf(stats: BigIntStats): FileId {
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
}

function kindOf(stats: BigIntStats): FileKind {
  if (stats.isFile()) return "regular";
  if (stats.isDirectory()) return "directory";
  if (stats.isFIFO()) return "fifo";
  if (stats.isCharacterDevice()) return "chardev";
  return "other";
}

/** Close a descriptor on a path that is already failing; the first failure is the one reported. */
function closeAfterFailure(ops: FsOps, fd: number): void {
  attempt(() => ops.closeSync(fd));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Stat a path (following symlinks) and return its identity or the OS error code. */
export function statTarget(path: string, options: OpsOption = {}): StatTarget {
  const ops = withDefaults(options.ops);
  const stat = attempt(() => ops.statSync(path, { bigint: true }));
  if (!stat.ok) return Object.freeze({ ok: false as const, code: stat.code });
  return Object.freeze({ ok: true as const, dev: stat.value.dev, ino: stat.value.ino });
}

/**
 * Decide whether the output target is the input file.
 * A missing target (ENOENT) is Absent; any other stat error is Unknown.
 * With both ino non-zero the (dev, ino) pairs decide; otherwise the real paths do,
 * failing closed (Unknown) on any input-side realpath error.
 */
export function identityDecision(
  idIn: FileId,
  target: StatTarget,
  inputPath: string,
  outputPath: string,
  options: OpsOption = {},
): IdentityResult {
  if (!target.ok) {
    return target.code === "ENOENT" ? { decision: "Absent" } : { decision: "Unknown", code: target.code, side: "output" };
  }
  if (idIn.ino !== 0n && target.ino !== 0n) {
    return { decision: target.dev === idIn.dev && target.ino === idIn.ino ? "Same" : "Distinct" };
  }

  // ino 0 on either side: identity is unavailable, compare canonical real paths
  const ops = withDefaults(options.ops);
  const realOut = attempt(() => ops.realpathSync(outputPath));
  if (!realOut.ok) {
    return realOut.code === "ENOENT" ? { decision: "Absent" } : { decision: "Unknown", code: realOut.code, side: "output" };
  }
  const realIn = attempt(() => ops.realpathSync(inputPath));
  if (!realIn.ok) return { decision: "Unknown", code: realIn.code, side: "input" };
  return { decision: realOut.value === realIn.value ? "Same" : "Distinct" };
}

// ---------------------------------------------------------------------------
// Input: one read-only descriptor, bounded read
// ---------------------------------------------------------------------------

function inputFailure<T>(path: string, op: string, code: string): Result<T> {
  return failure({ reason: "INPUT", stage: "PRE", path, op, code });
}

/**
 * Open the input once, read-only, and fstat that descriptor. Identity, kind and
 * size all come from the descriptor, so replacing the path afterwards changes nothing.
 */
export function openInput(
  inputPath: string,
  options: OpsOption & { hooks?: { afterInputOpen?(): void } } = {},
): Result<InputHandle> {
  const ops = withDefaults(options.ops);
  const opened = attempt(() => ops.openSync(inputPath, O_RDONLY));
  if (!opened.ok) return inputFailure(inputPath, "open", opened.code);
  const fd = opened.value;
  options.hooks?.afterInputOpen?.();

  const stat = attempt(() => ops.fstatSync(fd, { bigint: true }));
  if (!stat.ok) {
    closeAfterFailure(ops, fd);
    return inputFailure(inputPath, "fstat", stat.code);
  }
  return success(Object.freeze({ fd, id: idOf(stat.value), kind: kindOf(stat.value), size: stat.value.size, path: inputPath }));
}

/**
 * Read every byte through the input descriptor. A regular file whose fstat size
 * exceeds the cap is refused before any read; otherwise the read stops with a
 * SIZE failure as soon as the running total exceeds the cap (FIFOs, devices and
 * growing files included). The bytes are returned undecoded.
 */
export function readInput(handle: InputHandle, options: OpsOption & { maxBytes?: number } = {}): Result<Buffer> {
  const ops = withDefaults(options.ops);
  const maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
  if (handle.kind === "regular" && handle.size > BigInt(maxBytes)) {
    return failure({ reason: "SIZE", stage: "PRE", path: handle.path, detail: `${handle.size} bytes` });
  }

  // One byte past the cap is enough to know it was exceeded, so no read asks for more.
  const limit = maxBytes + 1;
  const sized = handle.kind === "regular" ? Number(handle.size) + 1 : READ_CHUNK_BYTES;
  let buffer = Buffer.allocUnsafe(Math.min(sized, limit));
  let total = 0;
  for (;;) {
    if (total === buffer.length) {
      const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, limit));
      buffer.copy(grown, 0, 0, total);
      buffer = grown;
    }
    const target = buffer;
    const read = attempt(() => ops.readSync(handle.fd, target, total, target.length - total, null));
    if (!read.ok) return inputFailure(handle.path, "read", read.code);
    if (read.value === 0) break;
    total += read.value;
    if (total > maxBytes) {
      return failure({ reason: "SIZE", stage: "PRE", path: handle.path, detail: `more than ${maxBytes} bytes read` });
    }
  }
  return success(buffer.subarray(0, total));
}

/** Close the input descriptor. A close error on a read-only descriptor loses no data, so it is not reported. */
export function closeInput(handle: InputHandle, options: OpsOption = {}): void {
  closeAfterFailure(withDefaults(options.ops), handle.fd);
}

// ---------------------------------------------------------------------------
// Guarded write
// ---------------------------------------------------------------------------

function writeFailure<T>(stage: FailureStage, path: string, op: string, code?: string, detail?: string): Result<T> {
  return failure({ reason: "WRITE", stage, path, op, ...(code === undefined ? {} : { code }), ...(detail === undefined ? {} : { detail }) });
}

/**
 * Exclusive create; on EEXIST exactly one write-only re-open with O_CREAT,
 * which never truncates. O_CREAT leaves an existing file's content as it is;
 * it makes the operating system apply its sticky-directory protections (Linux
 * fs.protected_regular, fs.protected_fifos) to an existing file another user
 * owns, and it creates the file (mode 0o666 before the umask, as the exclusive
 * create does) when the path is a symlink to a missing file or was removed
 * after the exclusive create failed.
 */
function openOutput(ops: FsOps, outputPath: string): Result<number> {
  const created = attempt(() => ops.openSync(outputPath, O_WRONLY | O_CREAT | O_EXCL, 0o666));
  if (created.ok) return success(created.value);
  if (created.code !== "EEXIST") return writeFailure("WPRE", outputPath, "open", created.code);
  const existing = attempt(() => ops.openSync(outputPath, O_WRONLY | O_CREAT, 0o666));
  if (!existing.ok) return writeFailure("WPRE", outputPath, "open", existing.code);
  return success(existing.value);
}

/**
 * Write `data` to the output through one verified descriptor:
 * open (exclusive create, else one write-only re-open that can create the file
 * but never truncates it), fstat, identity check against the input, ftruncate
 * only for a regular file, write until every byte is written (a zero-byte
 * write is a failure), close.
 * Failures before the first successful ftruncate or write are stage WPRE and
 * leave the output as it was, except for an empty file created by the
 * exclusive create or by the re-open (the target of a symlink to a missing
 * file, or a path removed between the two opens); later failures are WPOST,
 * after which the output may be empty or partial.
 */
export function guardedWrite(
  outputPath: string,
  data: Uint8Array,
  idIn: FileId,
  inputPath: string,
  options: OpsOption & { hooks?: { beforeOutputOpen?(): void } } = {},
): Result<WriteSuccess> {
  const ops = withDefaults(options.ops);
  options.hooks?.beforeOutputOpen?.();

  const opened = openOutput(ops, outputPath);
  if (!opened.ok) return failure(opened.error);
  const fd = opened.value;

  const stat = attempt(() => ops.fstatSync(fd, { bigint: true }));
  if (!stat.ok) {
    closeAfterFailure(ops, fd);
    return failure({ reason: "IDUNK", stage: "WPRE", path: outputPath, op: "fstat", code: stat.code, side: "output" });
  }
  const outputId = idOf(stat.value);
  const identity = identityDecision(idIn, { ok: true, dev: outputId.dev, ino: outputId.ino }, inputPath, outputPath, { ops });
  if (identity.decision === "Same") {
    closeAfterFailure(ops, fd);
    return failure({ reason: "SAME", stage: "WPRE", path: outputPath });
  }
  if (identity.decision === "Unknown") {
    closeAfterFailure(ops, fd);
    return failure({ reason: "IDUNK", stage: "WPRE", path: outputPath, op: "realpath", ...(identity.code === undefined ? {} : { code: identity.code }), side: identity.side ?? "output" });
  }

  // From the first successful ftruncate or positive write on, the output is modified.
  let mutated = false;
  const stage = (): FailureStage => (mutated ? "WPOST" : "WPRE");

  if (stat.value.isFile()) {
    const truncated = attempt(() => ops.ftruncateSync(fd, 0));
    if (!truncated.ok) {
      closeAfterFailure(ops, fd);
      return writeFailure(stage(), outputPath, "ftruncate", truncated.code);
    }
    mutated = true;
  }

  let offset = 0;
  while (offset < data.length) {
    const from = offset;
    const written = attempt(() => ops.writeSync(fd, data, from, data.length - from));
    if (!written.ok) {
      closeAfterFailure(ops, fd);
      return writeFailure(stage(), outputPath, "write", written.code);
    }
    if (written.value <= 0) {
      closeAfterFailure(ops, fd);
      return writeFailure(stage(), outputPath, "write", undefined, "zero progress");
    }
    offset += written.value;
    mutated = true;
  }

  const closed = attempt(() => ops.closeSync(fd));
  if (!closed.ok) return writeFailure(stage(), outputPath, "close", closed.code);

  return success(Object.freeze({ outputId, doneToStderr: isStdout(ops, outputId) }));
}

/** True iff fstat of fd 1 succeeds and has the identity of the output descriptor. */
function isStdout(ops: FsOps, outputId: FileId): boolean {
  const stdout = attempt(() => ops.fstatStdout());
  return stdout.ok && stdout.value.dev === outputId.dev && stdout.value.ino === outputId.ino;
}
