import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coordinatorAlive,
  type Holder,
  liveness,
  lockHolder,
  parseStart,
  procStart,
  releaseLock,
  takeLock,
} from '../../src/cli/lock.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { tempDir } from '../support/repo.ts';

const RULE = 'R-ONE-COORDINATOR';
const fresh = () => join(tempDir('ecp-lock-'), 'run.lock');
const stale = (lock: string) => {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, '1'), JSON.stringify({ pid: 999_999, start: 'long ago' }));
};
const A: Holder = { pid: 101, start: 'a' };
const B: Holder = { pid: 102, start: 'b' };
const C: Holder = { pid: 103, start: 'c' };
// Who's alive is whatever the schedule says, so an interleaving can be replayed exactly.
const world = (...live: Holder[]) => {
  const set = new Set(live.map((h) => h.pid));
  return { alive: (h: Holder) => set.has(h.pid), add: (h: Holder) => set.add(h.pid) };
};

describe('the coordinator lock', () => {
  it('a second taker fails while the first is alive', () => {
    const lock = fresh();
    expect(takeLock(lock)).toBe(true);
    assertNotForbidden(RULE, takeLock(lock), 'two owners');
    expect(lockHolder(lock)?.pid).toBe(process.pid);
  });
  it('a stale claim is taken over, and a corrupt one too', () => {
    const lock = fresh();
    stale(lock);
    expect(coordinatorAlive(lock)).toBe(false);
    expect(takeLock(lock)).toBe(true);
    const other = fresh();
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, '1'), 'not json');
    expect(takeLock(other)).toBe(true);
  });
  it('a release lets the next one in, and leaves no number free to reuse', () => {
    const lock = fresh();
    expect(takeLock(lock)).toBe(true);
    releaseLock(lock);
    expect(coordinatorAlive(lock)).toBe(false);
    expect(readdirSync(lock)).toEqual(['1']);
    expect(takeLock(lock)).toBe(true);
    expect(readdirSync(lock)).toEqual(['2']);
  });
  it('only the holder can release it', () => {
    const lock = fresh();
    expect(takeLock(lock)).toBe(true);
    releaseLock(lock, 999_999);
    expect(coordinatorAlive(lock)).toBe(true);
  });
});

describe('when a process cannot be inspected', () => {
  it('an owner already running is not unseated', () => {
    const lock = fresh();
    expect(takeLock(lock, { me: A, alive: () => false })).toBe(true);
    // Inspection fails after the first acquisition returned.
    const bWon = takeLock(lock, { me: B, alive: () => 'unknown' });
    assertNotForbidden(RULE, bWon, 'an inspection failure made a second owner');
    expect(lockHolder(lock)?.pid).toBe(A.pid);
    expect(coordinatorAlive(lock, () => 'unknown')).toBe(true);
  });
  it('no claim is published without a start time', () => {
    const lock = fresh();
    assertNotForbidden(
      RULE,
      takeLock(lock, { me: { pid: 7, start: null } }),
      'an unverifiable claim',
    );
    expect(lockHolder(lock)).toBeNull();
  });
  it('ps failing for real, not by lookup, leaves the owner in place', () => {
    const lock = fresh();
    expect(takeLock(lock)).toBe(true);
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      assertNotForbidden(RULE, takeLock(lock), 'no ps made a second owner');
      expect(coordinatorAlive(lock)).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  });
  it('a process ps says is gone really is taken over', () => {
    const lock = fresh();
    stale(lock);
    expect(takeLock(lock)).toBe(true);
  });
});

describe('what counts as evidence that an owner is dead', () => {
  const esrch = () => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  };
  const eperm = () => {
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
  };
  const eagain = () => {
    throw Object.assign(new Error('try again'), { code: 'EAGAIN' });
  };
  const fine = () => {};
  const THEN = 'Thu Nov  5 10:00:00 2026';
  const owner = { pid: 101, start: parseStart(THEN) };
  const says = (out: string | null) => () => out;
  it.each([
    ['the kernel says no such process', esrch, says(null), false],
    ['the PID now belongs to a later process', fine, says('Thu Nov  5 11:00:00 2026'), false],
    ['the same process', fine, says(THEN), true],
    ['the same process, spaced differently', fine, says('  Thu Nov 5  10:00:00 2026\n'), true],
    ["another user's process, same start", eperm, says(THEN), true],
    ['ps fails', fine, says(null), 'unknown'],
    ['empty output', fine, says(''), 'unknown'],
    ['whitespace only', fine, says('  \n'), 'unknown'],
    ['a partial line', fine, says('Thu Nov'), 'unknown'],
    ['a garbled line', fine, says('ps: out of memory'), 'unknown'],
    ['a month that does not exist', fine, says('Thu Xyz  5 10:00:00 2026'), 'unknown'],
    [
      'a start earlier than the owner: not a reuse',
      fine,
      says('Thu Nov  5 09:00:00 2026'),
      'unknown',
    ],
    ["another user's process, garbled", eperm, says('garbage'), 'unknown'],
    ["another user's process, empty", eperm, says(''), 'unknown'],
    ['the signal itself fails oddly', eagain, says('Thu Nov  5 11:00:00 2026'), 'unknown'],
  ])('%s', (_n, signal, start, expected) => {
    expect(liveness(owner, { signal, start })).toBe(expected);
  });
  it('a claim in an older format is never called reused', () => {
    const old = { pid: 101, start: 'Thu Nov  5 10:00:00 2026' };
    expect(liveness(old, { signal: fine, start: says('Thu Nov  5 11:00:00 2026') })).toBe(
      'unknown',
    );
  });
  it.each([
    ['ps gives no answer', { signal: fine, start: says(null) }],
    ['ps prints a partial line', { signal: fine, start: says('Thu Nov') }],
    ['ps prints garbage', { signal: fine, start: says('garbled output') }],
    ['the signal fails oddly', { signal: eagain, start: says(null) }],
  ])('%s after the first acquisition returned: no second owner', (_n, probes) => {
    const lock = fresh();
    const a = { pid: 101, start: parseStart(THEN) };
    expect(takeLock(lock, { me: a, alive: () => false })).toBe(true);
    // The contender's own start time is fine: only its look at the owner goes wrong.
    const bWon = takeLock(lock, { me: B, alive: (h) => liveness(h, probes) });
    assertNotForbidden(RULE, bWon, 'an inspection failure made a second owner');
    expect(lockHolder(lock)?.pid).toBe(a.pid);
    expect(coordinatorAlive(lock, (h) => liveness(h, probes))).toBe(true);
  });
  it('the same process reads the same under any time zone or locale', () => {
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    try {
      process.env.TZ = 'UTC0';
      const utc = procStart(process.pid);
      process.env.TZ = 'EET-2';
      process.env.LC_ALL = 'de_DE.UTF-8';
      expect(procStart(process.pid)).toBe(utc);
      expect(utc).toMatch(/Z$/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it('real ps reporting a real process stays alive, and a real dead PID is dead', () => {
    expect(liveness({ pid: process.pid, start: procStart(process.pid) })).toBe(true);
    expect(liveness({ pid: 999_999, start: 'long ago' })).toBe(false);
    expect(liveness({ pid: process.pid, start: '2000-01-01T00:00:00.000Z' })).toBe(false);
    expect(liveness({ pid: process.pid, start: 'another time' })).toBe('unknown');
  });
});

describe('claimants stopped between their steps', () => {
  it('both read a stale claim: the link has one winner', () => {
    const lock = fresh();
    stale(lock);
    const w = world();
    let bWon = false;
    const aWon = takeLock(lock, {
      me: A,
      alive: w.alive,
      afterRead: () => {
        bWon = takeLock(lock, { me: B, alive: w.alive });
        w.add(B);
      },
    });
    assertNotForbidden(RULE, aWon && bWon, 'two owners');
    expect(bWon).toBe(true);
    expect(lockHolder(lock)?.pid).toBe(B.pid);
  });
  it('A reads, then B takes and releases and C takes: A cannot get in under them', () => {
    const lock = fresh();
    stale(lock);
    const w = world();
    let cWon = false;
    const aWon = takeLock(lock, {
      me: A,
      alive: w.alive,
      afterRead: () => {
        expect(takeLock(lock, { me: B, alive: w.alive })).toBe(true);
        releaseLock(lock, B.pid);
        cWon = takeLock(lock, { me: C, alive: w.alive });
        w.add(C);
      },
    });
    expect(cWon).toBe(true);
    assertNotForbidden(RULE, aWon, 'two owners');
    expect(lockHolder(lock)?.pid).toBe(C.pid);
  });
  it('a lower number that was cleared away and reclaimed loses to the higher one', () => {
    const lock = fresh();
    stale(lock);
    const w = world();
    // A links 2 after B and C have moved on to 3 and 4, and 2 has been cleared.
    let cWon = false;
    const aWon = takeLock(lock, {
      me: A,
      alive: w.alive,
      afterRead: () => {
        expect(takeLock(lock, { me: B, alive: w.alive })).toBe(true);
        expect(takeLock(lock, { me: C, alive: w.alive })).toBe(true);
        cWon = true;
        w.add(C);
      },
    });
    expect(cWon).toBe(true);
    assertNotForbidden(RULE, aWon, 'a lower claim beat a live higher one');
    expect(lockHolder(lock)?.pid).toBe(C.pid);
    expect(readdirSync(lock).filter((f) => /^\d+$/.test(f))).toEqual(['3']);
  });
  it('a live holder is never unseated by someone acting on an old reading', () => {
    const lock = fresh();
    stale(lock);
    const w = world();
    let aWon = false;
    const bWon = takeLock(lock, {
      me: B,
      alive: w.alive,
      afterLink: () => {
        aWon = takeLock(lock, { me: A, alive: () => false });
      },
    });
    // B had linked but not yet checked, and A believed B dead. A is highest, so only A may go on.
    assertNotForbidden(RULE, aWon && bWon, 'two owners');
    expect(aWon).toBe(true);
    expect(lockHolder(lock)?.pid).toBe(A.pid);
  });
  it('of many processes starting together over a stale claim, exactly one wins', async () => {
    const script = `import { takeLock } from ${JSON.stringify(join(process.cwd(), 'src/cli/lock.ts'))};
      const won = takeLock(process.argv[2]);
      console.log(won ? 'won' : 'lost');
      setTimeout(() => {}, 1500);`;
    const file = join(tempDir('ecp-lock-'), 'take.mts');
    writeFileSync(file, script);
    for (let round = 0; round < 3; round++) {
      const lock = fresh();
      stale(lock);
      const results = await Promise.all(
        Array.from(
          { length: 6 },
          () =>
            new Promise<string>((res) => {
              const c = spawn(process.execPath, [file, lock], {
                stdio: ['ignore', 'pipe', 'ignore'],
              });
              let out = '';
              c.stdout.on('data', (d) => (out += d));
              c.on('close', () => res(out.trim()));
            }),
        ),
      );
      expect(results.filter((r) => r === 'won')).toHaveLength(1);
    }
  }, 120_000);
});
