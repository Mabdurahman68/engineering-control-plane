import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../../src/contracts/index.ts';
import { cliEnv } from '../support/cli.ts';

// Every recorded side-effect boundary: each intent and each outcome. Push and PR are tested in
// test/publish, where a publish block exists.
const BOUNDARIES = [
  'after:run.created',
  'after:gate.intent',
  'after:gate.finished',
  'after:plan.intent',
  'after_intent_before_spawn',
  'after_spawn_before_started',
  'after_started_before_child',
  'after:dispatch.started',
  'after:plan.accepted',
  'after:worktree.created',
  'after:dispatch.intent',
  'after:dispatch.finished',
  'after:dispatch.orphans_swept',
  'after:snapshot.recorded',
  'after:dispatch.classified',
  'after:claim.recorded',
  'after:claim.reconciled',
  'after:review.intent',
  'after:review.collected',
  'after:commit.intent',
  'after:tree.identity_checked',
  'after:commit.done',
  'after:merge.intent',
  'after:merge.done',
  'after:shadow.intent',
  'after:shadow.recorded',
  'after:decision.made',
  'after:gate.finished#3',
  'after:dispatch.finished#2',
  'after:review.collected#2',
];

const covered = new Set(BOUNDARIES.map((b) => b.replace(/^after:/, '').replace(/#.*$/, '')));
const PUBLISH_SUITE = new Set(['push.intent', 'push.done', 'pr.intent', 'pr.opened']);

describe('every intent and outcome event has a kill test', () => {
  it('fails the build if one is missing', () => {
    const outcomes = [
      'gate.finished',
      'plan.accepted',
      'dispatch.finished',
      'dispatch.classified',
      'review.collected',
      'commit.done',
      'merge.done',
      'push.done',
      'pr.opened',
      'shadow.recorded',
    ];
    const needed = [...EVENT_TYPES.filter((t) => t.endsWith('.intent')), ...outcomes];
    const missing = needed.filter((t) => !covered.has(t) && !PUBLISH_SUITE.has(t));
    expect(missing).toEqual([]);
  });
});

const signature = (home: string) => {
  const lines = readFileSync(join(home, 'runs/r1/ledger/events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const merged = new Set<string>();
  const passed = new Set<string>();
  let last = '';
  let invariant = 0;
  for (const e of lines) {
    if (e.type === 'merge.done' && e.data.task_id) merged.add(e.data.task_id);
    if (e.type === 'task.state_changed' && e.data.to === 'TASK_PASSED') passed.add(e.task_id);
    if (e.type === 'run.state_changed') last = e.data.to;
    if (e.type === 'invariant.violation') invariant += 1;
  }
  return { state: last, merged: [...merged].sort(), passed: [...passed].sort(), invariant };
};

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

describe('AC-D: kill at each boundary, resume, same terminal state', () => {
  it('a real process, killed with SIGKILL at each boundary, ends as an uninterrupted one does', async () => {
    const base = cliEnv();
    const plain = base.run(base.startArgs());
    expect(plain.status).toBe(0);
    const want = signature(base.home);
    expect(want.state).toBe('MOCK_RUN_COMPLETE');
    expect(want.invariant).toBe(0);
    const failures: string[] = [];
    await pool(BOUNDARIES, 6, async (point) => {
      const c = cliEnv();
      const killed = await c.runAsync(c.startArgs(), { ECP_FAILPOINT: point });
      if (killed.signal !== 'SIGKILL') {
        failures.push(
          `${point}: not killed (status ${killed.status}, ${killed.stderr.slice(0, 200)})`,
        );
        return;
      }
      let end = await c.runAsync(['resume', 'r1']);
      for (let tries = 0; tries < 3 && end.status !== 0; tries++)
        end = await c.runAsync(['resume', 'r1']);
      const got = signature(c.home);
      if (JSON.stringify(got) !== JSON.stringify(want))
        failures.push(`${point}: ${JSON.stringify(got)} ${end.stderr.slice(0, 300)}`);
    });
    expect(failures).toEqual([]);
  }, 600_000);
  it('repeats under a fixed seed: the same boundary gives the same result', async () => {
    const results: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = cliEnv();
      await c.runAsync(c.startArgs(), { ECP_FAILPOINT: 'after:dispatch.finished#2' });
      await c.runAsync(['resume', 'r1']);
      results.push(JSON.stringify(signature(c.home)));
    }
    expect(results[0]).toBe(results[1]);
  }, 120_000);
  it('a torn ledger tail recovers on resume; a corrupt one fails', async () => {
    const torn = cliEnv();
    await torn.runAsync(torn.startArgs(), { ECP_FAILPOINT: 'after:plan.accepted' });
    const file = join(torn.home, 'runs/r1/ledger/events.jsonl');
    const { truncateSync, statSync, writeFileSync } = await import('node:fs');
    truncateSync(file, statSync(file).size - 30);
    const ok = await torn.runAsync(['resume', 'r1']);
    expect(ok.stdout.trim()).toBe('r1 MOCK_RUN_COMPLETE');
    expect(readFileSync(file, 'utf8')).toContain('ledger.torn_tail_recovered');
    const bad = cliEnv();
    await bad.runAsync(bad.startArgs(), { ECP_FAILPOINT: 'after:plan.accepted' });
    const f2 = join(bad.home, 'runs/r1/ledger/events.jsonl');
    writeFileSync(f2, readFileSync(f2, 'utf8').replace('"spec_id"', '"spec_iX"'));
    const refused = await bad.runAsync(['resume', 'r1']);
    expect(refused.status).not.toBe(0);
  }, 120_000);
  it('a stale lock from a dead process does not block a resume', async () => {
    const c = cliEnv();
    await c.runAsync(c.startArgs(), { ECP_FAILPOINT: 'after:plan.intent' });
    expect(readFileSync(join(c.home, 'run.lock'), 'utf8')).toContain('pid');
    const end = await c.runAsync(['resume', 'r1']);
    expect(end.stdout.trim()).toBe('r1 MOCK_RUN_COMPLETE');
  }, 60_000);
});
