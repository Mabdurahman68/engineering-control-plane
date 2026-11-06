import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../support/assert.ts';
import { cliEnv } from '../support/cli.ts';
import { ledgerEvents, until } from '../support/fake-cli.ts';
import { holder } from '../support/lock-procs.ts';

const EXCLUSIVE = 'R-LOCK-EXCLUSIVE';
const CONTROL = 'R-LOCK-CONTROL';
const procs: ReturnType<typeof holder>[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.child.kill('SIGKILL');
});
const slow = (ms = 20_000) => [
  { match: { task: 'T1', step: 'work' }, behaviour: 'ok', delay_ms: ms },
];
const requests = (home: string, run: string) => {
  const d = join(home, 'runs', run, 'control', 'requests');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : [];
};
const acks = (home: string, run: string) =>
  ledgerEvents(home, run).filter((e) => e.type === 'operator.request_received');
const working = (home: string, run: string) =>
  until(() => ledgerEvents(home, run).some((e) => e.type === 'dispatch.intent'), 60_000);
const ledgerBytes = (home: string, run: string) => {
  const p = join(home, 'runs', run, 'ledger', 'events.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

describe('test 1: a live holder keeps every command out', () => {
  it('run, resume, publish, pause and cancel get no second ownership', async () => {
    const c = cliEnv();
    // A run to resume and control, crashed early so it isn't finished.
    const crashed = await c.runAsync(c.startArgs('r0'), { ECP_FAILPOINT: 'after:plan.intent' });
    expect(crashed.signal).toBe('SIGKILL');
    const h = holder(c.home);
    procs.push(h);
    await h.ready;
    expect((await h.ask('acquire')).ok).toBe(true);
    const before = ledgerBytes(c.home, 'r0');

    const run = c.run(c.startArgs('r1'));
    assertNotForbidden(
      EXCLUSIVE,
      existsSync(join(c.home, 'runs/r1/ledger/events.jsonl')),
      'a second run started',
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('another run is active (run held)');

    for (const args of [
      ['resume', 'r0'],
      ['publish', 'r0'],
    ]) {
      const r = c.run(args);
      expect(r.status).not.toBe(0);
      assertNotForbidden(
        EXCLUSIVE,
        ledgerBytes(c.home, 'r0') !== before,
        `${args[0]} wrote beside a live holder`,
      );
    }
    for (const request of ['pause', 'cancel']) {
      const r = c.run([request, 'r0'], { ECP_CONTROL_WAIT_MS: '500' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`${request} recorded for r0; a coordinator is active (run held)`);
      assertNotForbidden(
        EXCLUSIVE,
        ledgerBytes(c.home, 'r0') !== before,
        `${request} wrote beside a live holder`,
      );
    }
    expect(requests(c.home, 'r0')).toHaveLength(2);
  }, 120_000);
});

describe('test 9: readers', () => {
  it('status, metrics and report never repair, truncate or create anything', async () => {
    const c = cliEnv();
    await c.runAsync(c.startArgs('r1'), { ECP_FAILPOINT: 'after:plan.intent' });
    const p = join(c.home, 'runs/r1/ledger/events.jsonl');
    writeFileSync(p, `${readFileSync(p, 'utf8')}{"torn`);
    const bytes = readFileSync(p);
    const dirs = readdirSync(join(c.home, 'runs')).sort();
    for (const args of [
      ['status', 'r1'],
      ['status', '--all'],
      ['metrics'],
      ['report', 'r1'],
      ['status', 'nope'],
    ]) {
      c.run(args);
      expect(readFileSync(p).equals(bytes), args.join(' ')).toBe(true);
    }
    expect(readdirSync(join(c.home, 'runs')).sort()).toEqual(dirs);
    expect(existsSync(join(c.home, 'runs/nope'))).toBe(false);
    // The owner repairs it on resume.
    const resumed = c.run(['resume', 'r1']);
    expect(resumed.stdout).toContain('MOCK_RUN_COMPLETE');
    expect(readFileSync(p, 'utf8').includes('{"torn')).toBe(false);
  }, 120_000);
});

describe('test 10: pause and cancel', () => {
  it('the lock free: applied at once', async () => {
    const c = cliEnv();
    await c.runAsync(c.startArgs('r1'), { ECP_FAILPOINT: 'after:plan.intent' });
    const r = c.run(['cancel', 'r1']);
    expect(r.stdout.trim()).toBe('r1 CANCELLED');
    expect(acks(c.home, 'r1')).toHaveLength(1);
    expect(requests(c.home, 'r1')).toEqual([]);
  }, 120_000);
  it('the lock held by the same run: recorded, then applied by that coordinator', async () => {
    const c = cliEnv({ script: slow() });
    const running = c.runAsync(c.startArgs('r1'));
    expect(await working(c.home, 'r1')).toBe(true);
    const r = c.run(['cancel', 'r1']);
    expect(r.stdout).toContain('cancel for r1 taken up by the active coordinator (run r1)');
    expect((await running).stdout.trim()).toBe('r1 CANCELLED');
    expect(acks(c.home, 'r1')).toHaveLength(1);
  }, 120_000);
  it('the lock held by another run: recorded, and applied when its own run next resumes', async () => {
    const c = cliEnv({ script: slow(8000) });
    await c.runAsync(c.startArgs('r2'), { ECP_FAILPOINT: 'after:plan.intent' });
    const r1 = c.runAsync(c.startArgs('r1'));
    expect(await working(c.home, 'r1')).toBe(true);
    const before = ledgerBytes(c.home, 'r2');
    const r = c.run(['cancel', 'r2'], { ECP_CONTROL_WAIT_MS: '500' });
    expect(r.stdout).toContain('cancel recorded for r2; a coordinator is active (run r1)');
    expect(ledgerBytes(c.home, 'r2')).toBe(before);
    expect((await r1).stdout.trim()).toBe('r1 MOCK_RUN_COMPLETE');
    expect(requests(c.home, 'r2')).toHaveLength(1);
    expect(c.run(['resume', 'r2']).stdout.trim()).toBe('r2 CANCELLED');
    expect(requests(c.home, 'r2')).toEqual([]);
  }, 120_000);
  it('two cancels at once: one applies, the other is recorded, and both are acknowledged', async () => {
    const c = cliEnv();
    await c.runAsync(c.startArgs('r1'), { ECP_FAILPOINT: 'after:plan.intent' });
    // The first takes the lock and is held before it reads any request: the second can only record.
    const release = join(c.home, 'release-first');
    const first = c.runAsync(['cancel', 'r1'], {
      ECP_FAILPOINT_HOLD: 'after:run.resumed',
      ECP_FAILPOINT_RELEASE: release,
    });
    expect(
      await until(() => ledgerEvents(c.home, 'r1').some((e) => e.type === 'run.resumed'), 30_000),
    ).toBe(true);
    const second = c.run(['cancel', 'r1'], { ECP_CONTROL_WAIT_MS: '500' });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('cancel recorded for r1; a coordinator is active (run r1)');
    writeFileSync(release, '');
    expect((await first).stdout.trim()).toBe('r1 CANCELLED');
    const evs = ledgerEvents(c.home, 'r1');
    expect(new Set(acks(c.home, 'r1').map((e) => e.data.id)).size).toBe(2);
    expect(
      evs.filter((e) => e.type === 'run.state_changed' && e.data.to === 'CANCELLED'),
    ).toHaveLength(1);
    expect(requests(c.home, 'r1')).toEqual([]);
  }, 120_000);
  it('pause on a run the operator paused leaves it paused, and dispatches nothing', async () => {
    const c = cliEnv({ script: slow() });
    const running = c.runAsync(c.startArgs('r1'));
    expect(await working(c.home, 'r1')).toBe(true);
    c.run(['pause', 'r1']);
    expect((await running).stdout.trim()).toBe('r1 PAUSED_OPERATOR');
    const intents = () =>
      ledgerEvents(c.home, 'r1').filter((e) =>
        ['dispatch.intent', 'plan.intent', 'review.intent'].includes(e.type),
      ).length;
    const before = intents();
    const again = c.run(['pause', 'r1']);
    expect(again.stdout.trim()).toBe('r1 PAUSED_OPERATOR');
    expect(intents()).toBe(before);
    expect(acks(c.home, 'r1').at(-1)?.data.effective).toBe(false);
  }, 120_000);
  it('a lock that cannot be attempted: recorded, and exit 2', async () => {
    const c = cliEnv();
    await c.runAsync(c.startArgs('r1'), { ECP_FAILPOINT: 'after:plan.intent' });
    // A lock file this user can't open: the attempt fails, and not because it's held.
    const { chmodSync } = await import('node:fs');
    const lock = join(c.home, 'coordinator.lock');
    chmodSync(lock, 0o000);
    try {
      const r = c.run(['cancel', 'r1']);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain('cancel recorded for r1; the lock could not be attempted');
      expect(requests(c.home, 'r1')).toHaveLength(1);
    } finally {
      chmodSync(lock, 0o600);
    }
    expect(statSync(lock).isFile()).toBe(true);
  }, 120_000);
});

describe('test 18: pause and cancel together', () => {
  it('against a live coordinator, with the cancel arriving after the pause is acknowledged: cancel wins', async () => {
    const c = cliEnv({ script: slow() });
    const release = join(c.home, 'release-coordinator');
    // The coordinator acknowledges the pause, then is held there, before its file goes and before the
    // pause takes effect. The cancel arrives in that gap.
    const running = c.runAsync(c.startArgs('r1'), {
      ECP_FAILPOINT_HOLD: 'after:operator.request_received',
      ECP_FAILPOINT_RELEASE: release,
    });
    expect(await working(c.home, 'r1')).toBe(true);
    const p = c.run(['pause', 'r1'], { ECP_CONTROL_WAIT_MS: '1500' });
    expect(p.stdout).toContain('pause recorded for r1');
    expect(acks(c.home, 'r1').map((e) => e.data.request)).toEqual(['pause']);
    const x = c.run(['cancel', 'r1'], { ECP_CONTROL_WAIT_MS: '500' });
    expect(x.stdout).toContain('cancel recorded for r1');
    writeFileSync(release, '');
    const end = await running;
    assertNotForbidden(
      CONTROL,
      end.stdout.trim() !== 'r1 CANCELLED',
      `ended ${end.stdout.trim()}, cancel left`,
    );
    expect(acks(c.home, 'r1').map((e) => e.data.request)).toEqual(['pause', 'cancel']);
    expect(requests(c.home, 'r1')).toEqual([]);
  }, 120_000);
  it('against no coordinator: both kept, the run ends cancelled, both acknowledged, with no extra resume', async () => {
    const c = cliEnv();
    await c.runAsync(c.startArgs('r1'), { ECP_FAILPOINT: 'after:plan.intent' });
    await Promise.all([c.runAsync(['pause', 'r1']), c.runAsync(['cancel', 'r1'])]);
    const evs = ledgerEvents(c.home, 'r1');
    expect(
      acks(c.home, 'r1')
        .map((e) => e.data.request)
        .sort(),
    ).toEqual(['cancel', 'pause']);
    expect(evs.filter((e) => e.type === 'run.state_changed').at(-1)?.data.to).toBe('CANCELLED');
    expect(requests(c.home, 'r1')).toEqual([]);
  }, 120_000);
});

describe('test 19: a crash around the acknowledgement', () => {
  it('after the ledger event, before the file goes: resume removes it without acting twice', async () => {
    const c = cliEnv({ script: slow(8000) });
    const running = c.runAsync(c.startArgs('r1'), { ECP_FAILPOINT: 'control.between' });
    expect(await working(c.home, 'r1')).toBe(true);
    c.run(['cancel', 'r1']);
    expect((await running).signal).toBe('SIGKILL');
    const resumed = c.run(['resume', 'r1']);
    const a = acks(c.home, 'r1');
    assertNotForbidden(
      CONTROL,
      a.length !== 1 || resumed.stdout.trim() !== 'r1 CANCELLED',
      `${a.length} acks, ${resumed.stdout.trim()}`,
    );
    expect(requests(c.home, 'r1')).toEqual([]);
  }, 120_000);
  it('before the ledger event: resume applies the request, once', async () => {
    const c = cliEnv();
    await c.runAsync(c.startArgs('r1'), { ECP_FAILPOINT: 'after:plan.intent' });
    // The cancel's own coordinator dies after resuming and before it reads any request.
    const killed = await c.runAsync(['cancel', 'r1'], { ECP_FAILPOINT: 'after:run.resumed' });
    expect(killed.signal).toBe('SIGKILL');
    expect(acks(c.home, 'r1')).toEqual([]);
    expect(requests(c.home, 'r1')).toHaveLength(1);
    const resumed = c.run(['resume', 'r1']);
    assertNotForbidden(CONTROL, resumed.stdout.trim() !== 'r1 CANCELLED', resumed.stdout);
    expect(acks(c.home, 'r1')).toHaveLength(1);
    expect(requests(c.home, 'r1')).toEqual([]);
  }, 120_000);
});
