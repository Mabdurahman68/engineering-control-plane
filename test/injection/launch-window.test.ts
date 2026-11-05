import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../support/assert.ts';
import { cliEnv } from '../support/cli.ts';
import { fakeWorld, ledgerEvents, loggedWorkers, pidAlive, until } from '../support/fake-cli.ts';

const RULE = 'R-C5-LAUNCH';
const ITERATIONS = Number(process.env.ECP_LAUNCH_RUNS ?? 200);
const POOL = 4;

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function relaysUnder(ecpHome: string): number[] {
  const out = execFileSync('ps', ['-ww', '-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter((l) => l.includes('relay.mjs') && l.includes(ecpHome))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

const killAll = (pids: number[]) => {
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
};

type Kind =
  | 'after_intent_before_spawn'
  | 'after_spawn_before_started'
  | 'after_started_before_child'
  | 'relay';

async function iteration(i: number): Promise<string[]> {
  const rand = seeded(7919 * (i + 1));
  const kinds: Kind[] = [
    'after_intent_before_spawn',
    'after_spawn_before_started',
    'after_started_before_child',
    'relay',
  ];
  const kind = kinds[i % 4] as Kind;
  // Half of them at the planner, half at the first writer.
  const atWriter = i % 8 >= 4;
  const c = cliEnv();
  const w = fakeWorld([{ behaviour: atWriter ? 'hang_writers' : 'hang' }]);
  const policy = ['--policy', resolve('policy')];
  const args = ['run', c.specPath, ...policy, '--run-id', 'r1'];
  const problems: string[] = [];
  const lateFor: string[] = [];
  const started = () => ledgerEvents(c.home, 'r1').filter((e) => e.type === 'dispatch.started');
  const intents = () =>
    ledgerEvents(c.home, 'r1').filter(
      (e) => e.type === 'dispatch.intent' || e.type === 'plan.intent',
    );
  const firstWorker = () => loggedWorkers(w.home).filter((x) => pidAlive(x.pid)).length > 0;
  let coordinator: ReturnType<typeof c.runAsync>;
  const killRelay = async () => {
    await new Promise((r) => setTimeout(r, Math.floor(rand() * 800)));
    killAll(relaysUnder(c.home));
  };

  if (kind === 'relay') {
    coordinator = c.runAsync(args, w.env);
    if (!(await until(firstWorker, 60_000))) problems.push('no worker started');
    await killRelay();
    const before = started().length;
    if (!(await until(() => started().length > before, 60_000))) problems.push('no next attempt');
  } else {
    const nth = atWriter ? 3 : 1;
    const r = await c.runAsync(args, { ...w.env, ECP_FAILPOINT: `${kind}@${nth}` });
    if (r.signal !== 'SIGKILL') problems.push(`coordinator wasn't killed: ${r.signal} ${r.stderr}`);
    // A relay that's alive when it's swept overwrites result.json as it goes, so some must already be dead.
    if (rand() < 0.5 || (kind === 'after_spawn_before_started' && i % 16 < 8)) await killRelay();
    // A late result from the attempt the coordinator lost, before anything has looked at it.
    const open = intents().at(-1);
    const notStarted = !started().some((e) => e.data.attempt_id === open?.data.attempt_id);
    if (notStarted && open) {
      lateFor.push(open.data.attempt_id);
      mkdirSync(open.data.out_dir, { recursive: true });
      writeFileSync(
        join(open.data.out_dir, 'result.json'),
        JSON.stringify({
          schema: 'delegate-relay.result.v1',
          status: 'completed',
          exitCode: 0,
          finalMessage: 'late',
        }),
      );
    }
    const reattachable = kind === 'after_started_before_child';
    const count = started().length;
    coordinator = c.runAsync(['resume', 'r1'], w.env);
    // Settled means the recovery has acted: a new attempt, or a relay left alone by re-attaching.
    await until(() => started().length > count, reattachable ? 4000 : 60_000);
  }

  // At most one live worker for each task, by the PIDs the fixtures recorded.
  const live = loggedWorkers(w.home).filter((x) => pidAlive(x.pid));
  const byCwd = new Map<string, number>();
  for (const x of live) byCwd.set(x.cwd, (byCwd.get(x.cwd) ?? 0) + 1);
  for (const [cwd, n] of byCwd) if (n > 1) problems.push(`${n} live workers in ${cwd}`);
  const byTask = new Map<string, number>();
  for (const x of live) {
    const task = /\/(T\d+)-g\d+/.exec(x.cwd)?.[1];
    if (task) byTask.set(task, (byTask.get(task) ?? 0) + 1);
  }
  for (const [t, n] of byTask) if (n > 1) problems.push(`${n} live workers for ${t}`);

  c.run(['cancel', 'r1'], w.env);
  const end = await Promise.race([
    coordinator,
    new Promise<null>((r) => setTimeout(() => r(null), 90_000)),
  ]);
  if (end === null) problems.push('the coordinator did not finish after cancel');

  // Once it has stopped, nothing is left: no relay, and no worker the fixtures started.
  const clean = await until(
    () => relaysUnder(c.home).length === 0 && loggedWorkers(w.home).every((x) => !pidAlive(x.pid)),
    20_000,
  );
  if (!clean) {
    const left = loggedWorkers(w.home)
      .filter((x) => pidAlive(x.pid))
      .map((x) => x.pid);
    const argv = execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(c.home))
      .join(' | ')
      .slice(0, 600);
    const types = ledgerEvents(c.home, 'r1')
      .map((e) => `${e.type}:${e.data.attempt_id ?? ''}`)
      .slice(-14);
    problems.push(`left alive: workers ${left.join(',')}; ${argv}; ${types.join(' ')}`);
  }

  // The late result was never taken as that attempt's work.
  for (const id of lateFor) {
    const finished = ledgerEvents(c.home, 'r1').filter(
      (e) => e.type === 'dispatch.finished' && e.data.attempt_id === id,
    );
    if (finished.some((e) => e.data.status === 'completed')) {
      problems.push(`a late result was collected for ${id}`);
    }
  }

  killAll([...relaysUnder(c.home), ...loggedWorkers(w.home).map((x) => x.pid)]);
  rmSync(c.home, { recursive: true, force: true });
  return problems.map((p) => `#${i} ${kind}${atWriter ? ' writer' : ''}: ${p}`);
}

describe('killed in the launch window', () => {
  it(`leaves no orphan, one worker a task, and fences a late result, over ${ITERATIONS} runs`, async () => {
    const problems: string[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: POOL }, async () => {
        while (next < ITERATIONS) {
          const i = next++;
          problems.push(...(await iteration(i)));
        }
      }),
    );
    assertNotForbidden(RULE, problems.length > 0, problems.slice(0, 20).join('\n'));
    expect(problems).toEqual([]);
  }, 1_200_000);
});
