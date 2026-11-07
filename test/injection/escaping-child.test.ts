import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RealScanner } from '../../src/workers/relay/proc.ts';
import { authoriseClis } from '../../src/workers/relay/real-worker-guard.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { cliEnv } from '../support/cli.ts';
import { fakeWorld, ledgerEvents, pidAlive, until } from '../support/fake-cli.ts';
import { sh } from '../support/repo.ts';

const RULE = 'B2-ESCAPING';
const held: number[] = [];
afterEach(() => {
  // Killed by held PID: a scan could never be trusted to find these.
  for (const p of held.splice(0)) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
});

const heartbeatLines = (home: string) => {
  const p = join(home, 'escape-heartbeat');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').length : 0;
};
const heldPids = (home: string) => {
  const p = join(home, 'escape-pids');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(Number) : [];
};

describe.each([
  ['changes directory', 'chdir', true],
  ['rewrites argv', 'argv', false],
  ['starts a new session', 'session', false],
  ['does all three', 'chdir,argv,session', true],
])('a child that %s', (_n, flags, escapesScan) => {
  it('is only ever judged by its heartbeat and a held PID; a late result is fenced; the tree holds', async () => {
    const c = cliEnv();
    const w = fakeWorld([{ behaviour: 'escape_writers', flags }]);
    const args = ['run', c.specPath, '--policy', resolve('policy'), '--run-id', 'r1'];
    // Stopped just after the first writer's attempt is closed, with its child still going.
    const stopped = c.run(args, { ...w.env, ECP_FAILPOINT: 'after:dispatch.classified@3' });
    expect(stopped.signal).toBe('SIGKILL');
    held.push(...heldPids(w.home));

    // A result it drops now is late: the attempt is closed.
    const closed = ledgerEvents(c.home, 'r1')
      .filter((e) => e.type === 'dispatch.classified')
      .map((e) => e.data.attempt_id);
    const closedWriters = ledgerEvents(c.home, 'r1').filter(
      (e) => e.type === 'dispatch.intent' && closed.includes(e.data.attempt_id),
    );
    expect(closedWriters.length).toBeGreaterThan(0);
    for (const a of closedWriters) {
      writeFileSync(
        join(a.data.out_dir, 'result.json'),
        JSON.stringify({
          schema: 'delegate-relay.result.v1',
          status: 'failed',
          exitCode: 1,
          finalMessage: 'late',
        }),
      );
    }
    const r = c.run(['resume', 'r1'], w.env);
    const pids = heldPids(w.home);
    held.push(...pids);

    const events = ledgerEvents(c.home, 'r1');
    for (const a of closedWriters) {
      const again = events.filter(
        (e) => e.type === 'dispatch.finished' && e.data.attempt_id === a.data.attempt_id,
      );
      assertNotForbidden(RULE, again.length > 1, 'a late result reopened a closed attempt');
      assertNotForbidden(
        RULE,
        again.some((e) => e.data.status === 'failed'),
        'a late result replaced the real one',
      );
    }
    expect(r.stdout + r.stderr).toContain('MOCK_RUN_COMPLETE');
    expect(pids.length).toBeGreaterThan(0);

    // Liveness, from what the harness holds. The scan's answer is only recorded next to it.
    const writers = events.filter((e) => e.type === 'dispatch.intent');
    const alive = pids.filter(pidAlive);
    const scanner = new RealScanner();
    let seenByScan = 0;
    for (const a of writers) {
      const hits = await scanner.scan({
        attempt_id: a.data.attempt_id,
        out_dir: a.data.out_dir,
        cwd: a.data.cwd,
      });
      seenByScan += hits.filter((h) => alive.includes(h.pid)).length;
    }
    if (escapesScan) {
      // This stage's known limit, recorded and not hidden: real containment needs the M11 machine.
      expect(alive.length).toBeGreaterThan(0);
      expect(seenByScan).toBe(0);
      const beat = heartbeatLines(w.home);
      expect(await until(() => heartbeatLines(w.home) > beat, 3000)).toBe(true);
    }

    // The integrated tree holds only what the attempts committed, whatever a survivor did after.
    const state = JSON.parse(readFileSync(join(c.home, 'runs/r1/run.json'), 'utf8'));
    expect(state.state).toBe('MOCK_RUN_COMPLETE');
    const files = sh(c.repo.dir, 'ls-tree', '-r', '--name-only', state.integration.tip).split('\n');
    assertNotForbidden(
      RULE,
      files.some((f) => f.startsWith('escape') || f.startsWith('fake-cli')),
      'a survivor changed the live tree',
    );
    expect(files.sort()).toEqual(['README.md', 'src/t1/T1.txt', 'src/t2/T2.txt']);
  }, 180_000);
});

describe('a real rung, with this stage unable to contain children', () => {
  it('refuses to run: nothing real is on the allowed list', () => {
    const allowed = authoriseClis(resolve('.'), '/usr/bin:/bin');
    assertNotForbidden(RULE, allowed.allowed, 'a CLI outside the fixtures was allowed');
  });
});
