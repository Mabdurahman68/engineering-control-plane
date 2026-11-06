import {
  closeSync,
  constants as C,
  fstatSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';

// The coordinator lock is a kernel advisory lock (BSD flock semantics), taken with an exclusive,
// non-blocking open and held on that descriptor for the coordinator's whole life. While the holder
// exists, running, stopped or asleep, another exclusive open fails with EAGAIN. When it's gone, the
// kernel frees the lock. No PID, process listing, start time or clock decides anything.
//
// Preconditions, stated in docs/DECISIONS.md: only ecp creates or opens this file, nobody deletes,
// renames or replaces it, and it sits on a local APFS or HFS volume (src/cli/fscheck.ts). Replacement is
// detected on a best-effort basis by assertOwner, and that is detection, not fencing.

// Apple's value, from xnu bsd/sys/fcntl.h. Node doesn't export it.
export const O_EXLOCK = 0x20;
const FLAGS = C.O_RDWR | C.O_CREAT | O_EXLOCK | C.O_NONBLOCK | C.O_NOFOLLOW;
const META_BYTES = 128;

export type FsIdentity = {
  fstat: (fd: number) => { dev: number | bigint; ino: number | bigint };
  stat: (path: string) => { dev: number | bigint; ino: number | bigint };
};
const REAL_FS: FsIdentity = { fstat: (fd) => fstatSync(fd), stat: (p) => statSync(p) };

// On a detected loss, or an identity that can't be checked: one line on stderr and an immediate exit.
// No ledger write, event, report, notification or cleanup. The next resume reconciles as after a crash.
function lost(why: string): never {
  try {
    writeSync(2, `ecp: coordinator lock ${why}; stopping now\n`);
  } finally {
    process.exit(70);
  }
}

export class CoordinatorLock {
  readonly path: string;
  private readonly fd: number;
  private readonly fs: FsIdentity;
  private released = false;
  constructor(path: string, fd: number, fs: FsIdentity) {
    this.path = path;
    this.fd = fd;
    this.fs = fs;
  }
  // Before every ledger mutation and every coordinator write under a run.
  assertOwner(): void {
    if (this.released) throw new Error('a coordinator write after the lock was released');
    let same = false;
    try {
      const held = this.fs.fstat(this.fd);
      const named = this.fs.stat(this.path);
      same = held.dev === named.dev && held.ino === named.ino;
    } catch {
      lost('identity could not be verified');
    }
    if (!same) lost('file was replaced');
  }
  // Display only, never an input to a decision: written once through the held descriptor, at offset 0,
  // in a fixed width, so nothing is truncated or replaced. This is the only place the clock is read.
  writeMeta(runId: string): void {
    const rec = {
      pid: process.pid,
      run_id: runId.slice(0, 64),
      started_at: new Date().toISOString(),
    };
    const buf = Buffer.alloc(META_BYTES, ' ');
    buf.write(JSON.stringify(rec), 0, META_BYTES - 1, 'utf8');
    buf.write('\n', META_BYTES - 1);
    writeSync(this.fd, buf, 0, META_BYTES, 0);
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.fd);
  }
}

export type Acquired =
  | { ok: true; lock: CoordinatorLock }
  | { ok: false; held: true }
  | { ok: false; held: false; error: string };

export function acquireLock(
  path: string,
  o: { platform?: string; fs?: FsIdentity } = {},
): Acquired {
  if ((o.platform ?? process.platform) !== 'darwin') {
    return { ok: false, held: false, error: 'the coordinator lock needs macOS in this version' };
  }
  let fd: number;
  try {
    fd = openSync(path, FLAGS, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return { ok: false, held: true };
    return { ok: false, held: false, error: `${code ?? 'error'}: ${(err as Error).message}` };
  }
  return { ok: true, lock: new CoordinatorLock(path, fd, o.fs ?? REAL_FS) };
}

// For display. Opening read-only asks for no lock, so it neither waits for nor disturbs the holder.
export function readLockMeta(
  path: string,
): { pid: number; run_id: string; started_at: string } | null {
  let fd: number;
  try {
    fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(META_BYTES);
    const n = readSync(fd, buf, 0, META_BYTES, 0);
    return JSON.parse(buf.subarray(0, n).toString('utf8').trim());
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
