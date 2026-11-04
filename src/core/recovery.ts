import type { RawOutcome } from '../contracts/index.ts';
import { spawnFailed, type Engine } from './engine.ts';
import { InvariantViolation, type AttemptRec } from './reducer.ts';

function ref(a: AttemptRec) {
  return { attempt_id: a.attempt_id, out_dir: a.out_dir, cwd: a.cwd };
}

// Kill, wait, kill harder, then confirm. Nothing proceeds until the check is clean.
export async function killAttempt(e: Engine, a: AttemptRec): Promise<number> {
  const { scanner, killer } = e.p;
  const found = await scanner.scan(ref(a));
  if (found.length > 0) {
    await killer.kill(
      found.map((x) => x.pid),
      'SIGTERM',
    );
    await killer.sleep(10_000);
    const remaining = await scanner.scan(ref(a));
    if (remaining.length > 0)
      await killer.kill(
        remaining.map((x) => x.pid),
        'SIGKILL',
      );
    const last = await scanner.scan(ref(a));
    if (last.length > 0) {
      throw new InvariantViolation(
        `attempt ${a.attempt_id} still has live processes: ${last.map((x) => x.pid).join(', ')}`,
      );
    }
  }
  return found.length;
}

// After any relay exit, kill what remains of the attempt and confirm, before anything collects its
// result, releases its family or reuses its worktree (state machine §7.4, step 4).
export async function sweepAttempt(e: Engine, a: AttemptRec): Promise<void> {
  if (e.s.attempts[a.attempt_id].swept) return;
  const found = await killAttempt(e, a);
  e.append('dispatch.orphans_swept', a.task_id, { attempt_id: a.attempt_id, found });
}

// The one rule: re-attach only to a proven live relay, and otherwise kill.
export type ProofInput = {
  started: boolean;
  pid: number | null;
  startTime: string | null;
  outDir: string;
  scan: { pid: number; start_time: string | null; argv: string }[];
  alive: boolean;
  now: number;
  deadlineMs: number;
};
export function planRecovery(p: ProofInput): 'reattach' | 'kill' {
  if (!p.started || p.pid === null) return 'kill';
  if (!p.alive) return 'kill';
  if (p.now >= p.deadlineMs + 60_000) return 'kill';
  const proc = p.scan.find((x) => x.pid === p.pid);
  if (!proc || proc.start_time !== p.startTime || !proc.argv.includes(p.outDir)) return 'kill';
  return 'reattach';
}

export const lostOutcome = (): RawOutcome => ({
  ...spawnFailed('relay lost'),
  spawn_failed: false,
  result_present: false,
});

// Runs once on resume, before any new work. Scanning sends no signal; `planRecovery` decides.
export async function reconcileOpenAttempts(e: Engine): Promise<void> {
  for (const a of Object.values(e.s.attempts)) {
    if (a.finished || a.fenced || a.class !== null) continue;
    const rung = e.rung(a.rung);
    const adapter = rung ? e.p.adapters[rung.adapter] : undefined;
    const scan = await e.p.scanner.scan(ref(a));
    const alive = a.pid !== null ? await e.p.scanner.isAlive(a.pid, a.start_time) : false;
    const plan = planRecovery({
      started: a.started,
      pid: a.pid,
      startTime: a.start_time,
      outDir: a.out_dir,
      scan,
      alive,
      now: e.now(),
      deadlineMs: a.deadline_ms,
    });
    if (plan === 'reattach' && adapter) {
      const handle = await adapter.attach({
        attempt_id: a.attempt_id,
        out_dir: a.out_dir,
        cwd: a.cwd,
        pid: a.pid,
        start_time: a.start_time,
      });
      if (handle !== 'gone') {
        const slot = { adapter, handle, done: null, startedMs: e.now(), reattached: true };
        e.inflight.set(a.attempt_id, slot);
        e.watch(a.attempt_id, slot);
        continue;
      }
    }
    const found = await killAttempt(e, a);
    e.append('dispatch.orphans_swept', a.task_id, { attempt_id: a.attempt_id, found });
    if (!a.started && found === 0) {
      // Nothing ran, or nothing survived: a new attempt, with nothing charged.
      e.append('attempt.result_fenced', a.task_id, {
        attempt_id: a.attempt_id,
        reason: 'no process, no start',
      });
      if (a.mode === 'write')
        e.append('reservation.released', a.task_id, { attempt_id: a.attempt_id });
      continue;
    }
    // The relay is gone. If it published before dying, the result is still good, and is collected.
    let raw: RawOutcome = lostOutcome();
    if (adapter && a.started) {
      const handle = await adapter.attach({
        attempt_id: a.attempt_id,
        out_dir: a.out_dir,
        cwd: a.cwd,
        pid: null,
        start_time: null,
      });
      if (handle !== 'gone') raw = await adapter.wait(handle);
    }
    e.recordFinish(a, raw);
  }
}
