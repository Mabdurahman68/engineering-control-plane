import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// One active run at a time. The lock is a directory of numbered claims, and the owner is whoever holds
// the highest number, if that process is alive. Nobody ever removes or replaces a claim that could be
// someone's: taking over a stale claim means claiming the next number, and a link either creates that
// number or fails. Having linked, a claimant must still find itself highest, or it has lost.
//
// Why two can't both hold it: say N < M both succeed. M's claimant read the highest number as M - 1 >= N
// before it linked, so N was already there, and it went on only because N's holder was dead. N's holder
// wasn't. If instead N's claimant looked after M was linked, it found M and gave up.

export type Holder = { pid: number; start: string | null };

// What's asked of the OS, apart so a test can make each answer happen.
export type Probes = {
  platform: string;
  // Signal 0: delivers nothing. Throws ESRCH only if there's no such process.
  signal: (pid: number) => void;
  // What `ps` printed for the start time, or null if it failed. Used on macOS.
  start: (pid: number) => string | null;
  // /proc/<pid>/stat and the boot ID, or null. Used on Linux.
  stat: (pid: number) => string | null;
  bootId: () => string | null;
};

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const REAL: Probes = {
  platform: process.platform,
  signal: (pid) => {
    process.kill(pid, 0);
  },
  start: (pid) => {
    try {
      // `lstart` follows the time zone and locale, so both are fixed: one process, one rendering.
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  },
  stat: (pid) => read(`/proc/${pid}/stat`),
  bootId: () => read('/proc/sys/kernel/random/boot_id')?.trim() || null,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LSTART = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

// An instant, or null for anything that isn't a whole, real start time: a partial or garbled line, a
// day or month that doesn't exist, or a weekday that doesn't fit the date. Nothing is rounded over.
export function parseStart(raw: string | null): string | null {
  const m = LSTART.exec((raw ?? '').trim().replace(/[ \t]+/g, ' '));
  if (!m) return null;
  const [, wd, mon, d, hh, mm, ss, y] = m as unknown as string[];
  const month = MONTHS.indexOf(mon);
  const [day, h, min, sec, year] = [d, hh, mm, ss, y].map(Number);
  if (month < 0 || h > 23 || min > 59 || sec > 59) return null;
  const at = new Date(Date.UTC(year, month, day, h, min, sec));
  if (at.getUTCDate() !== day || at.getUTCMonth() !== month || DAYS[at.getUTCDay()] !== wd)
    return null;
  return at.toISOString();
}

// The start ticks, field 22, read after the last ')', since a command name can hold anything.
export function parseStatTicks(stat: string | null): string | null {
  if (!stat) return null;
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = rest[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}

// A process identity that a clock change can't move. On Linux, `lstart` is boot time plus ticks, and
// boot time shifts when the wall clock is set, so it isn't used: the boot ID and the ticks are. macOS
// records a process's start time once, when the process starts, and `ps` prints that. Elsewhere there's
// no identity, and only the kernel's ESRCH can show an owner gone.
export function identityOf(pid: number, probes: Probes = REAL): string | null {
  if (probes.platform === 'linux') {
    const boot = probes.bootId();
    const ticks = parseStatTicks(probes.stat(pid));
    return boot && ticks ? `linux:${boot}:${ticks}` : null;
  }
  if (probes.platform === 'darwin') {
    const at = parseStart(probes.start(pid));
    return at ? `darwin:${at}` : null;
  }
  return null;
}

export function procStart(pid: number): string | null {
  return identityOf(pid, REAL);
}

export type Liveness = boolean | 'unknown';

// Dead needs evidence: the kernel saying there's no such process, or the PID now belonging to a later
// process, which is what a reused PID looks like. Same identity is alive. Anything else, including an
// identity that can't be read, one that is earlier, or a claim in another format, is unknown, and
// unknown keeps the owner.
export function liveness(h: Holder, probes: Probes = REAL): Liveness {
  try {
    probes.signal(h.pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return 'unknown';
  }
  const seen = identityOf(h.pid, probes);
  if (seen === null || h.start === null) return 'unknown';
  if (seen === h.start) return true;
  const [kind, ...was] = h.start.split(':');
  const [seenKind, ...now] = seen.split(':');
  if (kind !== seenKind) return 'unknown';
  if (kind === 'linux') {
    const [wasBoot, wasTicks] = was;
    const [nowBoot, nowTicks] = now;
    // Another boot: whatever has this PID now isn't the owner.
    if (wasBoot !== nowBoot) return false;
    return BigInt(nowTicks) > BigInt(wasTicks) ? false : 'unknown';
  }
  if (kind === 'darwin') {
    const wasAt = was.join(':');
    const nowAt = now.join(':');
    if (Number.isNaN(Date.parse(wasAt))) return 'unknown';
    return nowAt > wasAt ? false : 'unknown';
  }
  return 'unknown';
}

function claims(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+$/.test(f))
    .map(Number)
    .sort((a, b) => a - b);
}

function readClaim(dir: string, n: number): Holder | null {
  try {
    const rec = JSON.parse(readFileSync(join(dir, String(n)), 'utf8'));
    return typeof rec.pid === 'number' ? { pid: rec.pid, start: rec.start ?? null } : null;
  } catch {
    return null;
  }
}

export function lockHolder(dir: string): Holder | null {
  const highest = claims(dir).at(-1);
  return highest === undefined ? null : readClaim(dir, highest);
}

// An owner that can't be ruled out counts as alive.
export function coordinatorAlive(dir: string, alive: (h: Holder) => Liveness = liveness): boolean {
  const h = lockHolder(dir);
  return h !== null && alive(h) !== false;
}

// The hooks exist so a test can stop a claimant between its steps, and run another in that gap.
export function takeLock(
  dir: string,
  o: {
    me?: Holder;
    alive?: (h: Holder) => Liveness;
    afterRead?: () => void;
    afterLink?: () => void;
  } = {},
): boolean {
  const alive = o.alive ?? ((h: Holder) => liveness(h));
  const me = o.me ?? { pid: process.pid, start: procStart(process.pid) };
  // A claim with no start time could never be told from a reused PID. Better no claim.
  if (me.start === null) return false;
  mkdirSync(dir, { recursive: true });
  // One reading for both questions: judging one claim and numbering past another would jump a live owner.
  const highest = claims(dir).at(-1) ?? 0;
  const holder = highest ? readClaim(dir, highest) : null;
  if (holder && alive(holder) !== false) return false;
  const next = highest + 1;
  o.afterRead?.();
  const tmp = join(dir, `tmp-${me.pid}-${next}`);
  writeFileSync(tmp, JSON.stringify(me));
  try {
    linkSync(tmp, join(dir, String(next)));
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
  o.afterLink?.();
  const now = claims(dir);
  if (now.at(-1) !== next) {
    rmSync(join(dir, String(next)), { force: true });
    return false;
  }
  // Only numbers below the owner's can go. They can't be anyone's any more.
  for (const n of now) if (n < next) rmSync(join(dir, String(n)), { force: true });
  return true;
}

// The claim stays, marked as given up. Removing it would let the number be claimed by someone who
// looked before it existed.
export function releaseLock(dir: string, pid: number = process.pid): void {
  const highest = claims(dir).at(-1);
  if (highest === undefined || readClaim(dir, highest)?.pid !== pid) return;
  const tmp = join(dir, `tmp-release-${pid}`);
  writeFileSync(tmp, JSON.stringify({ released: true }));
  renameSync(tmp, join(dir, String(highest)));
}
