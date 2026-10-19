/**
 * Unit tests for src/cli/safe-output.ts: file identity, the single input
 * descriptor with its bounded read, and the guarded write.
 *
 * The module is loaded inside every test, so each requirement fails on its
 * own while the module does not exist yet.
 *
 * Interface these tests rely on (all exports of src/cli/safe-output.ts):
 *
 *   type Result<T> = { ok: true; value: T } | { ok: false; error: SafeFailure }
 *   interface SafeFailure {
 *     reason: "INPUT" | "SAME" | "IDUNK" | "SIZE" | "WRITE";
 *     stage?: "PRE" | "WPRE" | "WPOST";   // required on guardedWrite failures
 *     path: string;                        // the affected path as given
 *     code?: string;                       // Node error code when an OS error is involved
 *   }                                      // a zero-progress write has no code and names
 *                                          // "zero" progress in one of its fields

 *   interface FileId { dev: bigint; ino: bigint }
 *   type FileKind = "regular" | "fifo" | "chardev" | "directory" | "other"
 *
 *   ops (every field optional, node:fs defaults): openSync, fstatSync, statSync,
 *   readSync, ftruncateSync, writeSync, closeSync, realpathSync (node:fs
 *   signatures, positional forms; stat calls use { bigint: true }; reads use
 *   readSync(fd, buffer, offset, length, position) and writes the Buffer form
 *   writeSync(fd, buffer, offset, length[, position])), and
 *   fstatStdout(): BigIntStats (the fstat of fd 1).
 *
 *   identityDecision(idIn, target, inputPath, outputPath, { ops? })
 *     target = { ok: true; dev: bigint; ino: bigint } | { ok: false; code: string }
 *     -> { decision: "Same" | "Distinct" | "Absent" | "Unknown"; code?: string }
 *   openInput(inputPath, { ops?, hooks?: { afterInputOpen?(): void } })
 *     -> Result<{ fd: number; id: FileId; kind: FileKind; size: bigint }>
 *   readInput(handle, { maxBytes?, ops? }) -> Result<Buffer>
 *   guardedWrite(outputPath, data: Buffer, idIn, inputPath,
 *                { ops?, hooks?: { beforeOutputOpen?(): void } })
 *     -> Result<{ outputId: FileId; doneToStderr: boolean }>
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const SAFE_OUTPUT = join(ROOT, "src", "cli", "safe-output.ts");
const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_RDWR, O_RDONLY, S_IFMT, S_IFREG, S_IFIFO, S_IFCHR } = fs.constants;
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(): Promise<any> {
  return await import(/* @vite-ignore */ SAFE_OUTPUT);
}

function tmp(): string {
  return fs.mkdtempSync(join(tmpdir(), "safeout-"));
}

function sha(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function idOf(path: string): { dev: bigint; ino: bigint } {
  const s = fs.statSync(path, { bigint: true });
  return { dev: s.dev, ino: s.ino };
}

function osError(code: string, syscall: string): Error {
  const e = new Error(`${code}: injected failure, ${syscall}`) as Error & { code: string; syscall: string };
  e.code = code;
  e.syscall = syscall;
  return e;
}

type Call = { op: string; args: unknown[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

const OP_NAMES = ["openSync", "fstatSync", "statSync", "readSync", "ftruncateSync", "writeSync", "closeSync", "realpathSync"] as const;

/** Seam ops that record every call (before delegating) and allow per-op overrides. */
function tracedOps(overrides: Partial<Record<(typeof OP_NAMES)[number] | "fstatStdout", AnyFn>> = {}) {
  const calls: Call[] = [];
  const ops: Record<string, AnyFn> = {};
  for (const name of OP_NAMES) {
    ops[name] = (...args: unknown[]) => {
      calls.push({ op: name, args });
      const impl = overrides[name] ?? ((fs as unknown as Record<string, AnyFn>)[name]);
      return impl(...args);
    };
  }
  ops.fstatStdout = (...args: unknown[]) => {
    calls.push({ op: "fstatStdout", args });
    if (overrides.fstatStdout) return overrides.fstatStdout(...args);
    return fs.fstatSync(1, { bigint: true });
  };
  return { ops, calls };
}

/** A stdout identity that matches nothing used in a test. */
function unrelatedStdout(dir: string): () => fs.BigIntStats {
  const p = join(dir, "unrelated-stdout");
  fs.writeFileSync(p, "");
  return () => fs.statSync(p, { bigint: true });
}

/** Clone a BigIntStats with its file-type bits replaced (methods follow `mode`). */
function withKind(real: fs.BigIntStats, typeBits: number): fs.BigIntStats {
  const clone = Object.create(Object.getPrototypeOf(real));
  Object.assign(clone, real);
  clone.mode = (real.mode & ~BigInt(S_IFMT)) | BigInt(typeBits);
  return clone;
}

function opensOf(calls: Call[], path: string): Call[] {
  return calls.filter((c) => c.op === "openSync" && c.args[0] === path);
}

/** FC-103(e): no open with O_TRUNC or O_RDWR, numeric flags only for write opens, no write to another fd. */
function assertNoForbiddenOpens(calls: Call[]): void {
  for (const c of calls.filter((x) => x.op === "openSync")) {
    const flags = c.args[1];
    if (flags === undefined || flags === "r" || flags === O_RDONLY) continue;
    expect(typeof flags, `open flags for ${String(c.args[0])} must be numeric`).toBe("number");
    expect((flags as number) & O_TRUNC).toBe(0);
    expect((flags as number) & O_RDWR).toBe(0);
  }
}

// ---------------------------------------------------------------------------
// FC-104 IdentityDecision
// ---------------------------------------------------------------------------

describe("IdentityDecision (FC-104, CS-01, CS-05)", () => {
  const IN = "/clisafe/in.js";
  const OUT = "/clisafe/out.js";

  it("maps the output stat result: ENOENT is Absent, ENOTDIR/ELOOP/EACCES are Unknown with the code", async () => {
    const m = await load();
    const idIn = { dev: 1n, ino: 2n };
    expect(m.identityDecision(idIn, { ok: false, code: "ENOENT" }, IN, OUT).decision).toBe("Absent");
    for (const code of ["ENOTDIR", "ELOOP", "EACCES"]) {
      const d = m.identityDecision(idIn, { ok: false, code }, IN, OUT);
      expect(d.decision).toBe("Unknown");
      expect(d.code).toBe(code);
    }
  });

  it("compares (dev, ino) as exact BigInt values without consulting realpath", async () => {
    const m = await load();
    const { ops, calls } = tracedOps({
      realpathSync: () => {
        throw new Error("realpath must not be called when both ino are non-zero");
      },
    });
    const big = 2n ** 53n;
    expect(m.identityDecision({ dev: 1n, ino: 2n }, { ok: true, dev: 1n, ino: 2n }, IN, OUT, { ops }).decision).toBe("Same");
    expect(m.identityDecision({ dev: 1n, ino: big }, { ok: true, dev: 1n, ino: big + 1n }, IN, OUT, { ops }).decision).toBe("Distinct");
    expect(m.identityDecision({ dev: 1n, ino: 7n }, { ok: true, dev: 2n, ino: 7n }, IN, OUT, { ops }).decision).toBe("Distinct");
    expect(calls.filter((c) => c.op === "realpathSync")).toHaveLength(0);
  });

  it("falls back to realpath equality only when either ino is 0n, failing closed on input-side errors", async () => {
    const m = await load();
    const realpaths = (map: Record<string, string | Error>) =>
      tracedOps({
        realpathSync: (p: string) => {
          const v = map[p];
          if (v instanceof Error) throw v;
          if (v === undefined) throw osError("ENOENT", "realpath");
          return v;
        },
      });
    const z = { dev: 1n, ino: 0n };
    const t = { ok: true, dev: 1n, ino: 5n };

    let r = realpaths({ [IN]: "/real/a.js", [OUT]: "/real/a.js" });
    expect(m.identityDecision(z, t, IN, OUT, { ops: r.ops }).decision).toBe("Same");
    expect(r.calls.filter((c) => c.op === "realpathSync").length).toBeGreaterThan(0);

    r = realpaths({ [IN]: "/real/a.js", [OUT]: "/real/b.js" });
    expect(m.identityDecision(z, t, IN, OUT, { ops: r.ops }).decision).toBe("Distinct");

    // ino 0 on the output side only
    r = realpaths({ [IN]: "/real/a.js", [OUT]: "/real/a.js" });
    expect(m.identityDecision({ dev: 1n, ino: 5n }, { ok: true, dev: 1n, ino: 0n }, IN, OUT, { ops: r.ops }).decision).toBe("Same");

    r = realpaths({ [IN]: "/real/a.js", [OUT]: osError("ENOENT", "realpath") });
    expect(m.identityDecision(z, t, IN, OUT, { ops: r.ops }).decision).toBe("Absent");

    r = realpaths({ [IN]: "/real/a.js", [OUT]: osError("EACCES", "realpath") });
    const unk = m.identityDecision(z, t, IN, OUT, { ops: r.ops });
    expect(unk.decision).toBe("Unknown");
    expect(unk.code).toBe("EACCES");

    // any input-side realpath error fails closed, ENOENT included (AL-9)
    for (const code of ["ENOENT", "EACCES"]) {
      r = realpaths({ [IN]: osError(code, "realpath"), [OUT]: "/real/a.js" });
      expect(m.identityDecision(z, t, IN, OUT, { ops: r.ops }).decision).toBe("Unknown");
    }
  });
});

// ---------------------------------------------------------------------------
// FC-106, FC-107, FC-108 input open and bounded read
// ---------------------------------------------------------------------------

describe("single input descriptor and bounded read (FC-106, FC-107, FC-108, CS-01, CS-12)", () => {
  it("opens the input once read-only; replacing the input path after the open changes neither the bytes nor the identity", async () => {
    const m = await load();
    const dir = tmp();
    const input = join(dir, "in.js");
    const other = join(dir, "other.js");
    fs.writeFileSync(input, "var original = 1;\n");
    fs.writeFileSync(other, "var replacement = 2;\n");
    const originalId = idOf(input);
    const { ops, calls } = tracedOps();

    const opened = m.openInput(input, { ops, hooks: { afterInputOpen: () => fs.renameSync(other, input) } });
    expect(opened.ok).toBe(true);
    expect(opened.value.kind).toBe("regular");
    expect(opened.value.id).toEqual(originalId);
    expect(typeof opened.value.size).toBe("bigint");
    expect(idOf(input)).not.toEqual(originalId); // the hook really replaced the path

    const read = m.readInput(opened.value, { ops });
    expect(read.ok).toBe(true);
    expect(Buffer.from(read.value).toString("utf-8")).toBe("var original = 1;\n");

    const inputOpens = opensOf(calls, input);
    expect(inputOpens).toHaveLength(1);
    expect([O_RDONLY, "r", undefined]).toContain(inputOpens[0].args[1]);
    expect(calls.filter((c) => c.op === "statSync" && c.args[0] === input)).toHaveLength(0);
    for (const c of calls.filter((x) => x.op === "readSync")) expect(c.args[0]).toBe(opened.value.fd);
  });

  it("reports the input kind from fstat and an open failure as INPUT with the OS code", async () => {
    const m = await load();
    const dir = tmp();
    const missing = join(dir, "missing.js");
    const r = m.openInput(missing);
    expect(r.ok).toBe(false);
    expect(r.error.reason).toBe("INPUT");
    expect(r.error.code).toBe("ENOENT");
    expect(r.error.path).toBe(missing);

    const sub = join(dir, "subdir");
    fs.mkdirSync(sub);
    const d = m.openInput(sub);
    expect(d.ok).toBe(true);
    expect(d.value.kind).toBe("directory");

    const n = m.openInput("/dev/null");
    expect(n.ok).toBe(true);
    expect(n.value.kind).toBe("chardev");
  });

  it("refuses a regular file over the cap before any read and accepts exactly the cap", async () => {
    const m = await load();
    const dir = tmp();
    const over = join(dir, "over.js");
    const exact = join(dir, "exact.js");
    fs.writeFileSync(over, "x".repeat(17));
    fs.writeFileSync(exact, "y".repeat(16));

    const t1 = tracedOps();
    const h1 = m.openInput(over, { ops: t1.ops });
    const r1 = m.readInput(h1.value, { maxBytes: 16, ops: t1.ops });
    expect(r1.ok).toBe(false);
    expect(r1.error.reason).toBe("SIZE");
    expect(t1.calls.filter((c) => c.op === "readSync")).toHaveLength(0);

    const t2 = tracedOps();
    const h2 = m.openInput(exact, { ops: t2.ops });
    const r2 = m.readInput(h2.value, { maxBytes: 16, ops: t2.ops });
    expect(r2.ok).toBe(true);
    expect(Buffer.from(r2.value).toString("utf-8")).toBe("y".repeat(16));
  });

  it("stops reading as soon as the running total exceeds the cap (growing file, endless source)", async () => {
    const m = await load();
    const dir = tmp();
    const input = join(dir, "grows.js");
    fs.writeFileSync(input, "var a = 1;"); // fstat size 10, under the cap
    const returned: number[] = [];
    const { ops } = tracedOps({
      // an endless source: every read fills what was asked for
      readSync: (_fd: number, buf: Uint8Array, offset = 0, length?: number) => {
        const n = Math.max(1, Math.min(length ?? buf.length - offset, 7));
        buf.fill(0x61, offset, offset + n);
        returned.push(n);
        return n;
      },
    });
    const h = m.openInput(input, { ops });
    const r = m.readInput(h.value, { maxBytes: 16, ops });
    expect(r.ok).toBe(false);
    expect(r.error.reason).toBe("SIZE");
    const total = returned.reduce((a, b) => a + b, 0);
    const beforeLast = total - returned[returned.length - 1];
    expect(total).toBeGreaterThan(16);
    expect(beforeLast).toBeLessThanOrEqual(16); // no read issued after the total exceeded the cap
  });

  it("treats a read error as an INPUT refusal carrying the OS code", async () => {
    const m = await load();
    const dir = tmp();
    const input = join(dir, "in.js");
    fs.writeFileSync(input, "var a = 1;");
    const { ops } = tracedOps({
      readSync: () => {
        throw osError("EIO", "read");
      },
    });
    const h = m.openInput(input, { ops });
    const r = m.readInput(h.value, { ops });
    expect(r.ok).toBe(false);
    expect(r.error.reason).toBe("INPUT");
    expect(r.error.code).toBe("EIO");
  });
});

// ---------------------------------------------------------------------------
// FC-109 / FC-103 guarded write
// ---------------------------------------------------------------------------

function writeFixture() {
  const dir = tmp();
  const input = join(dir, "in.js");
  fs.writeFileSync(input, "var input = 'keep me';\n");
  return { dir, input, idIn: idOf(input), inSha: sha(input), data: Buffer.from("var output = 42;\nconsole.log(output);\n") };
}

describe("guarded write protocol (FC-109, FC-103, CS-05)", () => {
  it("absent output: exclusive create, fstat, ftruncate, full write, close on one descriptor; returns its identity", async () => {
    const m = await load();
    const { dir, input, idIn, data } = writeFixture();
    const out = join(dir, "out.js");
    let outFd = -1;
    const { ops, calls } = tracedOps({
      openSync: (p: string, f: number, mode?: number) => {
        const fd = fs.openSync(p, f, mode);
        if (p === out) outFd = fd;
        return fd;
      },
      fstatStdout: unrelatedStdout(dir),
    });
    const r = m.guardedWrite(out, data, idIn, input, { ops });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(out)).toEqual(data);
    expect(r.value.outputId).toEqual(idOf(out));
    expect(r.value.doneToStderr).toBe(false);

    const opens = opensOf(calls, out);
    expect(opens).toHaveLength(1);
    expect(opens[0].args[1]).toBe(O_WRONLY | O_CREAT | O_EXCL);
    const seq = calls.filter((c) => c.args[0] === outFd || c.args[0] === out).map((c) => c.op);
    const iFstat = seq.indexOf("fstatSync");
    const iTrunc = seq.indexOf("ftruncateSync");
    const iWrite = seq.indexOf("writeSync");
    expect(iFstat).toBeGreaterThan(0);
    expect(iTrunc).toBeGreaterThan(iFstat);
    expect(iWrite).toBeGreaterThan(iTrunc);
    expect(seq[seq.length - 1]).toBe("closeSync");
    for (const c of calls.filter((x) => x.op === "ftruncateSync")) expect(c.args).toEqual([outFd, 0]);
    for (const c of calls.filter((x) => x.op === "writeSync")) expect(c.args[0]).toBe(outFd);
    assertNoForbiddenOpens(calls);
  });

  it("existing distinct output: EEXIST leads to one O_WRONLY re-open, identity checked before any truncation, exact content", async () => {
    const m = await load();
    for (const prior of ["x".repeat(500), "y"]) {
      const { dir, input, idIn, inSha, data } = writeFixture();
      const out = join(dir, "out.js");
      fs.writeFileSync(out, prior);
      const { ops, calls } = tracedOps({ fstatStdout: unrelatedStdout(dir) });
      const r = m.guardedWrite(out, data, idIn, input, { ops });
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(out)).toEqual(data);
      const opens = opensOf(calls, out);
      expect(opens).toHaveLength(2);
      expect(opens[0].args[1]).toBe(O_WRONLY | O_CREAT | O_EXCL);
      expect(opens[1].args[1]).toBe(O_WRONLY);
      const ops2 = calls.map((c) => c.op);
      expect(ops2.indexOf("fstatSync", calls.indexOf(opens[1]))).toBeLessThan(ops2.indexOf("ftruncateSync"));
      expect(sha(input)).toBe(inSha);
      assertNoForbiddenOpens(calls);
    }
  });

  it("destination swapped to a symlink or hard link of the input before the open is refused as SAME with nothing written (witness: a distinct swap is written)", async () => {
    const m = await load();
    const swaps: Array<[string, (input: string, out: string) => void, boolean]> = [
      ["symlink", (input, out) => fs.symlinkSync(input, out), true],
      ["hard link", (input, out) => fs.linkSync(input, out), true],
      ["distinct file", (_input, out) => fs.writeFileSync(out, "unrelated"), false],
    ];
    for (const [label, swap, aliased] of swaps) {
      const { dir, input, idIn, inSha, data } = writeFixture();
      const out = join(dir, "out.js");
      const { ops, calls } = tracedOps({ fstatStdout: unrelatedStdout(dir) });
      const r = m.guardedWrite(out, data, idIn, input, { ops, hooks: { beforeOutputOpen: () => swap(input, out) } });
      if (aliased) {
        expect(r.ok, label).toBe(false);
        expect(r.error.reason, label).toBe("SAME");
        expect(r.error.stage, label).toBe("WPRE");
        expect(calls.filter((c) => c.op === "ftruncateSync" || c.op === "writeSync"), label).toHaveLength(0);
        expect(calls.some((c) => c.op === "closeSync"), label).toBe(true);
        expect(sha(input), label).toBe(inSha);
      } else {
        expect(r.ok, label).toBe(true);
        expect(fs.readFileSync(out), label).toEqual(data);
      }
    }
  });

  it("continues short writes until the whole buffer is written", async () => {
    const m = await load();
    const { dir, input, idIn, data } = writeFixture();
    const out = join(dir, "out.js");
    let outFd = -1;
    const counts: number[] = [];
    const { ops } = tracedOps({
      openSync: (p: string, f: number, mode?: number) => {
        const fd = fs.openSync(p, f, mode);
        if (p === out) outFd = fd;
        return fd;
      },
      writeSync: (fd: number, buf: unknown, offset?: number, length?: number, position?: number | null) => {
        if (typeof buf === "string") throw new Error("the guarded write must use the Buffer form of writeSync");
        const b = buf as Uint8Array;
        const off = offset ?? 0;
        const len = length ?? b.length - off;
        if (fd !== outFd) return fs.writeSync(fd, b, off, len, position);
        const n = fs.writeSync(fd, b, off, Math.min(len, 3), position);
        counts.push(n);
        return n;
      },
      fstatStdout: unrelatedStdout(dir),
    });
    const r = m.guardedWrite(out, data, idIn, input, { ops });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(out)).toEqual(data);
    expect(counts.length).toBeGreaterThan(1);
  });

  it("faults before the first mutation are WPRE refusals that leave the output as it was (open, fstat, ftruncate, first write on a non-regular output)", async () => {
    const m = await load();
    type Case = { label: string; prior: string | null; make: (out: string, state: { fd: number }) => Partial<Record<string, AnyFn>>; reason: string; code?: string };
    const cases: Case[] = [
      {
        label: "open error",
        prior: null,
        reason: "WRITE",
        code: "EACCES",
        make: (out) => ({
          openSync: (p: string, f: number, mode?: number) => {
            if (p === out) throw osError("EACCES", "open");
            return fs.openSync(p, f, mode);
          },
        }),
      },
      {
        label: "fstat error",
        prior: "PRIOR-BYTES",
        reason: "IDUNK",
        code: "EIO",
        make: (_out, st) => ({
          fstatSync: (fd: number, o?: fs.StatOptions) => {
            if (fd === st.fd) throw osError("EIO", "fstat");
            return fs.fstatSync(fd, o as fs.StatOptions & { bigint: true });
          },
        }),
      },
      {
        label: "ftruncate error on a regular output",
        prior: "PRIOR-BYTES",
        reason: "WRITE",
        code: "EIO",
        make: (_out, st) => ({
          ftruncateSync: (fd: number, len?: number) => {
            if (fd === st.fd) throw osError("EIO", "ftruncate");
            return fs.ftruncateSync(fd, len);
          },
        }),
      },
      {
        label: "first write returns 0 on a non-regular output",
        prior: "PRIOR-BYTES",
        reason: "WRITE",
        make: (_out, st) => ({
          fstatSync: (fd: number, o?: fs.StatOptions) => {
            const s = fs.fstatSync(fd, { bigint: true });
            return fd === st.fd ? withKind(s, S_IFIFO) : s;
          },
          writeSync: (fd: number, ...rest: unknown[]) => (fd === st.fd ? 0 : (fs.writeSync as AnyFn)(fd, ...rest)),
        }),
      },
      {
        label: "first write fails on a non-regular output",
        prior: "PRIOR-BYTES",
        reason: "WRITE",
        code: "EIO",
        make: (_out, st) => ({
          fstatSync: (fd: number, o?: fs.StatOptions) => {
            const s = fs.fstatSync(fd, { bigint: true });
            return fd === st.fd ? withKind(s, S_IFIFO) : s;
          },
          writeSync: (fd: number, ...rest: unknown[]) => {
            if (fd === st.fd) throw osError("EIO", "write");
            return (fs.writeSync as AnyFn)(fd, ...rest);
          },
        }),
      },
    ];
    for (const c of cases) {
      const { dir, input, idIn, inSha, data } = writeFixture();
      const out = join(dir, "out.js");
      if (c.prior !== null) fs.writeFileSync(out, c.prior);
      const st = { fd: -1 };
      const custom = c.make(out, st);
      const { ops, calls } = tracedOps({
        ...custom,
        openSync: (p: string, f: number, mode?: number) => {
          const fd = custom.openSync ? custom.openSync(p, f, mode) : fs.openSync(p, f, mode);
          if (p === out) st.fd = fd;
          return fd;
        },
        fstatStdout: unrelatedStdout(dir),
      });
      const r = m.guardedWrite(out, data, idIn, input, { ops });
      expect(r.ok, c.label).toBe(false);
      expect(r.error.reason, c.label).toBe(c.reason);
      expect(r.error.stage, c.label).toBe("WPRE");
      expect(r.error.path, c.label).toBe(out);
      if (c.code) expect(r.error.code, c.label).toBe(c.code);
      else {
        expect(r.error.code, c.label).toBeUndefined();
        expect(JSON.stringify(r.error), `${c.label}: zero progress is named as such`).toMatch(/zero/i);
      }
      if (c.prior === null) expect(fs.existsSync(out), c.label).toBe(false);
      else expect(fs.readFileSync(out, "utf-8"), c.label).toBe(c.prior);
      expect(sha(input), c.label).toBe(inSha);
      assertNoForbiddenOpens(calls);
    }
  });

  it("faults after the first mutation are WPOST refusals; only exit-relevant result and input integrity are asserted", async () => {
    const m = await load();
    type Case = { label: string; code?: string; make: (st: { fd: number; writes: number }) => Partial<Record<string, AnyFn>> };
    const cases: Case[] = [
      {
        label: "first write returns 0 after ftruncate on a regular output",
        make: (st) => ({ writeSync: (fd: number, ...rest: unknown[]) => (fd === st.fd ? 0 : (fs.writeSync as AnyFn)(fd, ...rest)) }),
      },
      {
        label: "first write fails after ftruncate on a regular output",
        code: "EIO",
        make: (st) => ({
          writeSync: (fd: number, ...rest: unknown[]) => {
            if (fd === st.fd) throw osError("EIO", "write");
            return (fs.writeSync as AnyFn)(fd, ...rest);
          },
        }),
      },
      {
        label: "write error after a positive write",
        code: "ENOSPC",
        make: (st) => ({
          writeSync: (fd: number, buf: Uint8Array, offset = 0, length?: number, position?: number | null) => {
            if (fd !== st.fd) return fs.writeSync(fd, buf, offset, length ?? buf.length - offset, position);
            st.writes++;
            if (st.writes === 1) return fs.writeSync(fd, buf, offset, 2, position);
            throw osError("ENOSPC", "write");
          },
        }),
      },
      {
        label: "close error after the writes",
        code: "EIO",
        make: (st) => ({
          closeSync: (fd: number) => {
            fs.closeSync(fd);
            if (fd === st.fd) throw osError("EIO", "close");
          },
        }),
      },
    ];
    for (const c of cases) {
      const { dir, input, idIn, inSha, data } = writeFixture();
      const out = join(dir, "out.js");
      fs.writeFileSync(out, "PRIOR-BYTES");
      const st = { fd: -1, writes: 0 };
      const custom = c.make(st);
      const { ops } = tracedOps({
        ...custom,
        openSync: (p: string, f: number, mode?: number) => {
          const fd = fs.openSync(p, f, mode);
          if (p === out) st.fd = fd;
          return fd;
        },
        fstatStdout: unrelatedStdout(dir),
      });
      const r = m.guardedWrite(out, data, idIn, input, { ops });
      expect(r.ok, c.label).toBe(false);
      expect(r.error.reason, c.label).toBe("WRITE");
      expect(r.error.stage, c.label).toBe("WPOST");
      expect(r.error.path, c.label).toBe(out);
      if (c.code) expect(r.error.code, c.label).toBe(c.code);
      expect(sha(input), c.label).toBe(inSha);
    }
  });

  it("truncates only a regular-file descriptor; non-regular kinds are written without ftruncate after the same identity check", async () => {
    const m = await load();
    for (const [label, bits, expectTrunc] of [
      ["regular", S_IFREG, true],
      ["character device", S_IFCHR, false],
      ["fifo", S_IFIFO, false],
    ] as Array<[string, number, boolean]>) {
      const { dir, input, idIn, data } = writeFixture();
      const out = join(dir, "out.js");
      const st = { fd: -1 };
      const { ops, calls } = tracedOps({
        openSync: (p: string, f: number, mode?: number) => {
          const fd = fs.openSync(p, f, mode);
          if (p === out) st.fd = fd;
          return fd;
        },
        fstatSync: (fd: number) => {
          const s = fs.fstatSync(fd, { bigint: true });
          return fd === st.fd ? withKind(s, bits) : s;
        },
        fstatStdout: unrelatedStdout(dir),
      });
      const r = m.guardedWrite(out, data, idIn, input, { ops });
      expect(r.ok, label).toBe(true);
      expect(calls.some((c) => c.op === "ftruncateSync"), label).toBe(expectTrunc);
      expect(calls.some((c) => c.op === "writeSync" && c.args[0] === st.fd), label).toBe(true);
    }

    // identity check on a non-regular descriptor: aliased => SAME, no write
    const { dir, input, idIn, inSha, data } = writeFixture();
    const out = join(dir, "out.js");
    const st = { fd: -1 };
    const { ops, calls } = tracedOps({
      openSync: (p: string, f: number, mode?: number) => {
        const fd = fs.openSync(p, f, mode);
        if (p === out) st.fd = fd;
        return fd;
      },
      fstatSync: (fd: number) => {
        const s = fs.fstatSync(fd, { bigint: true });
        return fd === st.fd ? withKind(s, S_IFCHR) : s;
      },
      fstatStdout: unrelatedStdout(dir),
    });
    const r = m.guardedWrite(out, data, idIn, input, { ops, hooks: { beforeOutputOpen: () => fs.linkSync(input, out) } });
    expect(r.ok).toBe(false);
    expect(r.error.reason).toBe("SAME");
    expect(calls.filter((c) => c.op === "writeSync" || c.op === "ftruncateSync")).toHaveLength(0);
    expect(sha(input)).toBe(inSha);
  });

  it("writes /dev/null without ftruncate and refuses a directory output with EISDIR and no write", async () => {
    const m = await load();
    const { dir, input, idIn, data } = writeFixture();
    const t1 = tracedOps({ fstatStdout: unrelatedStdout(dir) });
    const r1 = m.guardedWrite("/dev/null", data, idIn, input, { ops: t1.ops });
    expect(r1.ok).toBe(true);
    expect(t1.calls.some((c) => c.op === "ftruncateSync")).toBe(false);

    const outDir = join(dir, "outdir");
    fs.mkdirSync(outDir);
    const t2 = tracedOps({ fstatStdout: unrelatedStdout(dir) });
    const r2 = m.guardedWrite(outDir, data, idIn, input, { ops: t2.ops });
    expect(r2.ok).toBe(false);
    expect(r2.error.reason).toBe("WRITE");
    expect(r2.error.stage).toBe("WPRE");
    expect(r2.error.code).toBe("EISDIR");
    expect(t2.calls.some((c) => c.op === "writeSync")).toBe(false);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it("overwrites an existing write-only (mode 0200) output and refuses a dangling-symlink output leaving the target absent", async () => {
    const m = await load();
    const { dir, input, idIn, data } = writeFixture();
    const wo = join(dir, "write-only.js");
    fs.writeFileSync(wo, "OLD");
    fs.chmodSync(wo, 0o200);
    const r1 = m.guardedWrite(wo, data, idIn, input, { ops: tracedOps({ fstatStdout: unrelatedStdout(dir) }).ops });
    expect(r1.ok).toBe(true);
    fs.chmodSync(wo, 0o600);
    expect(fs.readFileSync(wo)).toEqual(data);

    const link = join(dir, "dangling.js");
    const target = join(dir, "target-does-not-exist.js");
    fs.symlinkSync(target, link);
    const r2 = m.guardedWrite(link, data, idIn, input, { ops: tracedOps({ fstatStdout: unrelatedStdout(dir) }).ops });
    expect(r2.ok).toBe(false);
    expect(r2.error.reason).toBe("WRITE");
    expect(r2.error.stage).toBe("WPRE");
    expect(r2.error.code).toBe("ENOENT");
    expect(fs.existsSync(target)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FC-121 Done destination decision (seam half of IT-18)
// ---------------------------------------------------------------------------

describe("Done destination from the fd-1 identity (FC-121, CS-15)", () => {
  it("reports doneToStderr only when fstat(1) has the identity of the verified output descriptor", async () => {
    const m = await load();
    const cases: Array<[string, (out: string, dir: string) => AnyFn, boolean]> = [
      ["fd 1 is the output", (out) => () => fs.statSync(out, { bigint: true }), true],
      ["fd 1 is another file", (_out, dir) => unrelatedStdout(dir), false],
      [
        "fstat(1) fails",
        () => () => {
          throw osError("EBADF", "fstat");
        },
        false,
      ],
    ];
    for (const [label, make, expected] of cases) {
      const { dir, input, idIn, data } = writeFixture();
      const out = join(dir, "out.js");
      const { ops } = tracedOps({ fstatStdout: make(out, dir) });
      const r = m.guardedWrite(out, data, idIn, input, { ops });
      expect(r.ok, label).toBe(true);
      expect(r.value.doneToStderr, label).toBe(expected);
      expect(fs.readFileSync(out), label).toEqual(data);
    }
  });
});

// ---------------------------------------------------------------------------
// FC-110 / FC-103 static placement checks
// ---------------------------------------------------------------------------

describe("safe-output module placement and mutation surface (FC-110, FC-103)", () => {
  it("imports only node:fs (and node:path) and contains no rename, unlink, temp-file or path-based write", () => {
    expect(fs.existsSync(SAFE_OUTPUT)).toBe(true);
    const src = fs.readFileSync(SAFE_OUTPUT, "utf-8");
    const specifiers = [...src.matchAll(/(?:^|\s)(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g)].map((x) => x[1]);
    const dynamic = [...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map((x) => x[1]);
    for (const s of [...specifiers, ...dynamic]) expect(["node:fs", "node:path"]).toContain(s);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\b(renameSync|unlinkSync|rmSync|writeFileSync|appendFileSync|truncateSync|copyFileSync|mkdirSync|mkdtempSync|chmodSync|createWriteStream)\b/);
    expect(src).not.toMatch(/\bO_TRUNC\b|\bO_RDWR\b/);
  });
});
