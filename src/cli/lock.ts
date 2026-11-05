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

// Three answers, not two. Only `ps` saying there's no such process means dead: if it couldn't run, or
// failed some other way, nothing is known, and an owner mustn't be unseated on that.
type Started = { known: true; start: string | null } | { known: false };

function inspect(pid: number): Started {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { known: true, start: out.trim() || null };
  } catch (err) {
    return (err as { status?: number }).status === 1
      ? { known: true, start: null }
      : { known: false };
  }
}

export function procStart(pid: number): string | null {
  const r = inspect(pid);
  return r.known ? r.start : null;
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

export type Liveness = boolean | 'unknown';

function isAlive(h: Holder): Liveness {
  const r = inspect(h.pid);
  if (!r.known) return 'unknown';
  return r.start !== null && r.start === h.start;
}

export function lockHolder(dir: string): Holder | null {
  const highest = claims(dir).at(-1);
  return highest === undefined ? null : readClaim(dir, highest);
}

// An owner that can't be ruled out counts as alive.
export function coordinatorAlive(dir: string, alive: (h: Holder) => Liveness = isAlive): boolean {
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
  const alive = o.alive ?? isAlive;
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
