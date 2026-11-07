import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockPathIn, prepareHome } from '../../src/cli/home.ts';
import { acquireLock } from '../../src/cli/lock.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { fakeWorld, loggedWorkers, pidAlive, until } from '../support/fake-cli.ts';
import { holder, openFds } from '../support/lock-procs.ts';
import { tempDir } from '../support/repo.ts';

const EXCLUSIVE = 'R-LOCK-EXCLUSIVE';
const OWNER = 'R-LOCK-OWNER';
const procs: ReturnType<typeof holder>[] = [];
const strays: number[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.child.kill('SIGKILL');
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
});
const start = async (home: string, env: Record<string, string> = {}) => {
  const h = holder(home, env);
  procs.push(h);
  expect(await h.ready).toBe(true);
  return h;
};
const freshHome = () => join(tempDir('ecp-lockhome-'), 'home');
const tryHere = (home: string) => acquireLock(lockPathIn(prepareHome({ home })));
// Everything under the home, with sizes and contents, to show nothing moved.
const snapshot = (dir: string): string => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      const st = statSync(p);
      return st.isDirectory()
        ? [`${p}/`, ...walk(p)]
        : [`${p} ${st.size} ${readFileSync(p).toString('base64')}`];
    });
  return walk(dir).sort().join('\n');
};
const stopped = (pid: number) => {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('T');
  } catch {
    return false;
  }
};

describe('test 2, 3, 6: the holder alive, stopped, killed or released', () => {
  it('a SIGKILLed holder frees the lock at once, once its exit is confirmed', async () => {
    const home = freshHome();
    const h = await start(home);
    expect((await h.ask('acquire')).ok).toBe(true);
    const held = tryHere(home);
    assertNotForbidden(EXCLUSIVE, held.ok, 'a second owner beside a live holder');
    h.child.kill('SIGKILL');
    expect((await h.exited).signal).toBe('SIGKILL');
    const r = tryHere(home);
    expect(r.ok).toBe(true);
    if (r.ok) r.lock.release();
  });
  it('a stopped holder still holds it; resumed and released, it is free', async () => {
    const home = freshHome();
    const h = await start(home);
    expect((await h.ask('acquire')).ok).toBe(true);
    h.child.kill('SIGSTOP');
    expect(await until(() => stopped(h.pid()), 5000)).toBe(true);
    const r = tryHere(home);
    assertNotForbidden(EXCLUSIVE, r.ok, 'a stopped holder lost its lock');
    expect(r.ok === false && r.held).toBe(true);
    h.child.kill('SIGCONT');
    expect((await h.ask('release')).released).toBe(true);
    const again = tryHere(home);
    expect(again.ok).toBe(true);
    if (again.ok) again.lock.release();
  });
  it('after a release another process takes it, and a write after release throws', async () => {
    const home = freshHome();
    const h = await start(home);
    expect((await h.ask('acquire')).ok).toBe(true);
    expect((await h.ask('append first')).appended).toBe(true);
    expect((await h.ask('release')).released).toBe(true);
    const other = await start(home);
    expect((await other.ask('acquire')).ok).toBe(true);
    const late = await h.ask('append-after-release');
    assertNotForbidden(OWNER, late.threw !== true, 'a write after release went through');
  });
});

describe('test 4: children launched by the holder', () => {
  it('a gate child and a relay keep running after the holder dies, and hold no lock', async () => {
    const home = freshHome();
    const w = fakeWorld([{ behaviour: 'hang' }]);
    const h = await start(home, w.env);
    expect((await h.ask('acquire')).ok).toBe(true);
    const work = tempDir('ecp-children-');
    const pidFile = join(work, 'gate.pid');
    expect((await h.ask(`spawn-gate ${pidFile}`)).spawned).toBe('gate');
    const relay = await h.ask(`spawn-relay ${work}`);
    expect(relay.spawned).toBe('relay');
    strays.push(relay.pid);
    // Independent handshakes: the gate child's own PID file, and the fake CLI's own log.
    expect(await until(() => existsSync(pidFile), 20_000)).toBe(true);
    const gatePid = Number(readFileSync(pidFile, 'utf8'));
    strays.push(gatePid);
    expect(await until(() => loggedWorkers(w.home).length > 0, 30_000)).toBe(true);
    const cliPid = (loggedWorkers(w.home)[0] as { pid: number }).pid;
    strays.push(cliPid);
    h.child.kill('SIGKILL');
    await h.exited;
    expect(pidAlive(gatePid) && pidAlive(relay.pid) && pidAlive(cliPid)).toBe(true);
    const r = tryHere(home);
    assertNotForbidden(EXCLUSIVE, !r.ok, 'a child kept the lock after its holder died');
    expect(pidAlive(gatePid) && pidAlive(cliPid)).toBe(true);
    if (r.ok) r.lock.release();
  }, 60_000);
});

describe('test 5 and 17: many starts on one fresh home', () => {
  it('exactly one owner, and one layout, however they interleave', async () => {
    for (let round = 0; round < 3; round++) {
      const home = freshHome();
      const hs = await Promise.all(Array.from({ length: 6 }, () => start(home)));
      const answers = await Promise.all(hs.map((h) => h.ask('acquire')));
      const owners = answers.filter((a) => a.ok);
      assertNotForbidden(EXCLUSIVE, owners.length !== 1, `${owners.length} owners`);
      expect(answers.filter((a) => a.error)).toEqual([]);
      expect(new Set(answers.map((a) => a.layoutIno)).size).toBe(1);
      expect(readFileSync(join(home, 'layout'), 'utf8')).toBe('ecp-home v2');
      expect(readdirSync(home).filter((f) => f.startsWith('layout.tmp-'))).toEqual([]);
      for (const h of hs) h.child.kill('SIGKILL');
    }
  }, 120_000);
});

describe('test 7 and 8: ownership lost', () => {
  it('the lock file replaced: the next check exits 70, and nothing under the home changes after', async () => {
    const home = freshHome();
    const h = await start(home);
    expect((await h.ask('acquire')).ok).toBe(true);
    expect((await h.ask('append first')).appended).toBe(true);
    // Replaced after the last check passed, before the next append.
    const lock = join(home, 'coordinator.lock');
    renameSync(lock, `${lock}.moved`);
    writeFileSync(lock, '');
    const before = snapshot(home);
    h.child.stdin?.write('append second\n');
    // Bounded: a holder that doesn't notice the loss never exits, and that is the forbidden outcome.
    const end = await Promise.race([
      h.exited,
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    assertNotForbidden(
      OWNER,
      end === null || end.code !== 70,
      `still running, or exited ${end?.code}`,
    );
    expect(h.stderr()).toContain('coordinator lock file was replaced');
    assertNotForbidden(OWNER, snapshot(home) !== before, 'something changed after the loss');
  });
  it('an identity that cannot be checked: the same', async () => {
    const home = freshHome();
    const h = await start(home);
    expect((await h.ask('acquire')).ok).toBe(true);
    expect((await h.ask('append first')).appended).toBe(true);
    expect((await h.ask('fail-fs')).failing).toBe(true);
    const before = snapshot(home);
    h.child.stdin?.write('append second\n');
    // Bounded: a holder that doesn't notice the loss never exits, and that is the forbidden outcome.
    const end = await Promise.race([
      h.exited,
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    assertNotForbidden(
      OWNER,
      end === null || end.code !== 70,
      `still running, or exited ${end?.code}`,
    );
    expect(h.stderr()).toContain('identity could not be verified');
    assertNotForbidden(OWNER, snapshot(home) !== before, 'something changed after the loss');
  });
});

describe('test 11: no descriptor leaks', () => {
  it('failed acquisitions and refused homes leave the open-descriptor count as it was', async () => {
    const home = freshHome();
    const h = await start(home);
    expect((await h.ask('acquire')).ok).toBe(true);
    const before = openFds();
    for (let i = 0; i < 50; i++) expect(tryHere(home).ok).toBe(false);
    const legacy = tempDir('ecp-legacy-');
    writeFileSync(join(legacy, 'run.lock'), '');
    for (let i = 0; i < 20; i++) expect(() => prepareHome({ home: legacy })).toThrow();
    expect(openFds()).toBe(before);
  });
});

describe('test 14: what the lock module may use', () => {
  const text = readFileSync(resolve('src/cli/lock.ts'), 'utf8');
  it('imports no child_process', () => {
    expect(text).not.toMatch(/child_process/);
  });
  it('reads the clock only in the metadata writer', () => {
    const uses = [...text.matchAll(/new Date\(|Date\.now\(|performance\.now\(|hrtime/g)];
    expect(uses).toHaveLength(1);
    const at = text.indexOf('new Date(');
    expect(text.lastIndexOf('writeMeta(', at)).toBeGreaterThan(-1);
    expect(text.slice(text.lastIndexOf('writeMeta(', at), at)).not.toMatch(/\n {2}[a-zA-Z]+\(/);
  });
  it('has none of the old liveness code', () => {
    for (const gone of [
      'liveness',
      'parseStart',
      'procStart',
      'identityOf',
      'Probes',
      'coordinatorAlive',
      'ps',
    ]) {
      expect(text).not.toMatch(new RegExp(`\\b${gone}\\b`));
    }
  });
});

describe('test 7, with the replacement between one append’s check and its write', () => {
  it('that append completes; the next check exits 70, and nothing changes after', async () => {
    const home = freshHome();
    const h = await start(home);
    expect((await h.ask('acquire')).ok).toBe(true);
    const go = join(tempDir('ecp-go-'), 'go');
    // The holder says when its check has passed; only then is the lock replaced, before the write.
    expect((await h.ask(`append-held ${go}`)).asserted).toBe(true);
    const { until } = await import('../support/fake-cli.ts');
    const p = join(home, 'runs/held/ledger/events.jsonl');
    const lock = join(home, 'coordinator.lock');
    renameSync(lock, `${lock}.moved`);
    writeFileSync(lock, '');
    writeFileSync(go, '');
    expect(
      await until(() => existsSync(p) && readFileSync(p, 'utf8').includes('in flight'), 10_000),
    ).toBe(true);
    const before = snapshot(home);
    h.child.stdin?.write('append after\n');
    const end = await Promise.race([
      h.exited,
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    assertNotForbidden(
      OWNER,
      end === null || end.code !== 70,
      `still running, or exited ${end?.code}`,
    );
    assertNotForbidden(OWNER, snapshot(home) !== before, 'something changed after the loss');
  });
});

describe('metadata', () => {
  it('a long or awkward run ID still makes a record that parses, within 128 bytes', async () => {
    const { readLockMeta } = await import('../../src/cli/lock.ts');
    for (const id of ['r'.repeat(200), 'é'.repeat(80), '"\\'.repeat(60), 'x'.repeat(64)]) {
      const home = freshHome();
      const r = tryHere(home);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      r.lock.writeMeta(id);
      const m = readLockMeta(lockPathIn(home));
      expect(m?.pid).toBe(process.pid);
      expect(id.startsWith(m?.run_id ?? 'none')).toBe(true);
      expect(statSync(lockPathIn(home)).size).toBe(128);
      r.lock.release();
    }
  });
});

describe('test 9, a repair without ownership', () => {
  it('is refused, and leaves the torn tail alone', async () => {
    const { FsLedgerStore, loadLedger, LedgerReadOnly } = await import(
      '../../src/ledger/ledger.ts'
    );
    const home = freshHome();
    const r = tryHere(home);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = join(home, 'runs/x/ledger/events.jsonl');
    const owned = new FsLedgerStore(p, { guard: () => r.lock.assertOwner() });
    owned.appendRaw('');
    writeFileSync(p, '{"torn');
    r.lock.release();
    // Released: the guard throws before anything is truncated.
    expect(() => loadLedger(new FsLedgerStore(p, { guard: () => r.lock.assertOwner() }))).toThrow(
      /released/,
    );
    expect(() => loadLedger(new FsLedgerStore(p, { readOnly: true }))).toThrow(LedgerReadOnly);
    expect(readFileSync(p, 'utf8')).toBe('{"torn');
  });
});
