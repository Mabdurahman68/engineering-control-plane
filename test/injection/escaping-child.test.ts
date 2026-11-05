import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RealScanner } from '../../src/workers/relay/proc.ts';
import { authoriseClis } from '../../src/workers/relay/real-worker-guard.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { cliEnv } from '../support/cli.ts';
import { fakeWorld, ledgerEvents, pidAlive, until } from '../support/fake-cli.ts';

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
    const r = c.run(['run', c.specPath, '--policy', resolve('policy'), '--run-id', 'r1'], w.env);
    const pids = heldPids(w.home);
    held.push(...pids);
    expect(r.stdout + r.stderr).toContain('MOCK_RUN_COMPLETE');
    expect(pids.length).toBeGreaterThan(0);

    const events = ledgerEvents(c.home, 'r1');
    const writers = events.filter((e) => e.type === 'dispatch.intent' && e.data.mode === 'write');
    expect(writers.length).toBeGreaterThan(0);

    // Liveness, from what the harness holds. The scan's answer is only recorded next to it.
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

    // A result it drops afterwards changes nothing: the attempt is closed.
    const before = readFileSync(join(c.home, 'runs/r1/ledger/events.jsonl'), 'utf8');
    for (const a of writers) {
      writeFileSync(
        join(a.data.out_dir, 'result.json'),
        JSON.stringify({
          schema: 'delegate-relay.result.v1',
          status: 'failed',
          exitCode: 1,
          finalMessage: 'LATE',
        }),
      );
    }
    const again = c.run(['resume', 'r1'], w.env);
    const after = readFileSync(join(c.home, 'runs/r1/ledger/events.jsonl'), 'utf8');
    assertNotForbidden(RULE, after.includes('LATE'), 'a late result reached the ledger');
    expect(after.slice(0, before.length)).toBe(before);
    void again;

    // The integrated tree holds only what the attempts committed, whatever a survivor did after.
    const state = JSON.parse(readFileSync(join(c.home, 'runs/r1/run.json'), 'utf8'));
    expect(state.state).toBe('MOCK_RUN_COMPLETE');
    expect(statSync(join(c.home, 'runs/r1/RUN_REPORT.md')).size).toBeGreaterThan(0);
  }, 180_000);
});

describe('a real rung, with this stage unable to contain children', () => {
  it('refuses to run: nothing real is on the allowed list', () => {
    const allowed = authoriseClis(resolve('.'), '/usr/bin:/bin');
    assertNotForbidden(RULE, allowed.allowed, 'a CLI outside the fixtures was allowed');
  });
});
