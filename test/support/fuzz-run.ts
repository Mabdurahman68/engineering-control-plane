import { SimulatedKill } from '../../src/core/ports.ts';
import { RUN_TERMINAL } from '../../src/core/tables.ts';
import { decision, events, makeSim, resumeSim, type Sim } from './harness.ts';

function rng(seed: number) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const WORKER = [
  'ok',
  'ok',
  'ok',
  'malformed_report',
  'no_report',
  'exit_nonzero',
  'rate_limit',
  'quota',
  'auth',
  'outage',
  'unknown_failure',
  'timeout',
  'hang_ignores_term',
  'crash_midway',
  'relay_lost',
  'edit_out_of_scope',
  'edit_control_file',
  'commit_head',
  'write_secret',
  'weaken_test',
  'claim_false_count',
  'claim_tests_passed_false',
  'no_change',
  'oscillate',
  'spawn_failure',
  'reports_touched_files',
  'dispute_finding',
  'dispute_no_evidence',
];
const REVIEW = [
  'reviewer_pass',
  'reviewer_pass',
  'reviewer_pass',
  'reviewer_fail',
  'reviewer_inconsistent',
  'reviewer_modifies_tree',
  'reviewer_incomplete',
  'reviewer_pass_with_blocker',
  'reported_family_mismatch',
  'unknown_failure',
  'relay_lost',
  'exit_nonzero',
  'spawn_failure',
  'rate_limit',
  'quota',
  'auth',
  'outage',
  'timeout',
  'malformed_report',
  'no_report',
  'crash_midway',
];
const STEP: Record<string, string[]> = {
  plan: [
    'planner_valid',
    'planner_valid',
    'planner_valid',
    'planner_invalid',
    'planner_spec_defect',
    'malformed_report',
    'no_report',
    'unknown_failure',
    'relay_lost',
    'exit_nonzero',
    'spawn_failure',
    'rate_limit',
    'quota',
    'auth',
    'outage',
    'timeout',
  ],
  plan_review: REVIEW,
  work: WORKER,
  repair: WORKER,
  review: REVIEW,
  acceptance: REVIEW,
  adversarial: REVIEW,
  lens: REVIEW,
  challenge: [
    'challenge_none',
    'challenge_file',
    'malformed_report',
    'quota',
    'auth',
    'outage',
    'timeout',
    'rate_limit',
    'relay_lost',
    'unknown_failure',
  ],
  adjudicate: [
    'adjudicate',
    'malformed_report',
    'quota',
    'auth',
    'outage',
    'timeout',
    'rate_limit',
    'relay_lost',
    'unknown_failure',
  ],
};
const RULINGS = ['waive', 'override', 'reject', 'split'];
const DEPTHS = ['QUICK', 'STANDARD', 'DEEP', 'EXHAUSTIVE'] as const;
const RISKS = ['low', 'medium', 'high', 'critical'] as const;
const PROBES = ['ok', 'ok', 'ok', 'ok', 'not_installed', 'auth_no', 'quota_exhausted'] as const;
const STOPS = [
  'after:dispatch.started',
  'after:gate.intent',
  'after:review.intent',
  'after:merge.intent',
  'after:dispatch.finished',
  'after:task.state_changed',
  'after:run.state_changed',
  'after:dispatch.classified',
  'after:plan.intent',
  'after:snapshot.recorded',
  'after:review.collected',
];

// A loop that keeps making events without progress is a hole too.
class FuzzLoop extends SimulatedKill {}

function guard(sim: Sim) {
  if (sim.ledger.content.length > 6_000_000) throw new FuzzLoop(`event loop: ${tail(sim)}`);
}
function tail(sim: Sim) {
  return sim.ledger.content
    .split('\n')
    .slice(-14)
    .map((l) => {
      try {
        const e = JSON.parse(l);
        return `${e.type} ${e.task_id ?? ''} ${JSON.stringify(e.data).slice(0, 90)}`;
      } catch {
        return '';
      }
    })
    .join(' // ');
}

export type Fuzz = { sim: Sim; steps: number; ended: string; violations: unknown[] };

// A run's script comes from its seed, so a failure replays exactly.
export type FuzzOptions = { shadow?: string | 'absent'; noStops?: boolean };

export async function fuzzRun(seed: number, opts: FuzzOptions = {}): Promise<Fuzz> {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const script: any[] = [];
  const count = 2 + Math.floor(r() * 14);
  const tasks = ['T1', 'T2', 'T3'];
  for (let i = 0; i < count; i++) {
    const step = pick(Object.keys(STEP));
    const behaviour = pick(STEP[step]);
    const match: any = { step };
    if (r() < 0.6 && !['plan', 'plan_review', 'acceptance', 'adversarial', 'lens'].includes(step))
      match.task = pick(tasks);
    const entry: any = { match, behaviour, times: 1 + Math.floor(r() * 3) };
    if (behaviour === 'adjudicate') entry.args = { ruling: pick(RULINGS) };
    if (behaviour === 'planner_invalid')
      entry.args = { kind: pick(['cycle', 'uncovered', 'overlap']) };
    if (behaviour === 'reviewer_inconsistent')
      entry.args = {
        kind: pick(['pass_failed_criterion', 'fail_no_blocker', 'unlinked', 'duplicate_subject']),
      };
    if (behaviour === 'reviewer_fail' && r() < 0.15) entry.args = { unverifiable: true };
    if (r() < 0.1) entry.delay_ms = Math.floor(r() * 120_000);
    script.push(entry);
  }
  if (opts.shadow && opts.shadow !== 'absent')
    script.unshift({ match: { step: 'shadow' }, behaviour: opts.shadow });
  const probes: any = {};
  if (r() < 0.15) probes[pick(['mock-openai', 'mock-anthropic', 'mock-glm'])] = pick(PROBES);
  const depth = pick(DEPTHS);
  const sim = makeSim({
    script,
    probes,
    shadow: Boolean(opts.shadow && opts.shadow !== 'absent'),
    spec: { requested_depth: depth, declared_risk: pick(RISKS) },
    plan:
      depth === 'QUICK'
        ? ({
            tasks: [
              {
                task_id: 'T1',
                goal: 'g',
                lane: 'implementation',
                allowed_paths: ['src/**'],
                forbidden_paths: [],
                acceptance_criteria: ['AC-1'],
                required_tests: ['unit'],
                depends_on: [],
              },
            ],
            proposed_risk: 'low',
            spec_defects: [],
          } as any)
        : undefined,
    policy: (p) => {
      if (r() < 0.1) p.settings.caps.run.invocations = 3 + Math.floor(r() * 10);
    },
  });
  const wantStop = r() < 0.4;
  const stopPick = pick(STOPS);
  const stopPoint = wantStop && !opts.noStops ? stopPick : null;
  const stopAt = 1 + Math.floor(r() * 3);
  const stopKind = pick(['pause', 'cancel', 'crash', 'crash', 'crash'] as const);
  let hits = 0;
  sim.failFn = (n) => {
    guard(sim);
    if (n !== stopPoint || hits < 0) return;
    hits++;
    if (hits !== stopAt) return;
    if (stopKind === 'crash') throw new SimulatedKill(n);
    sim.control = { request: stopKind };
  };
  let steps = 0;
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof FuzzLoop || !(err instanceof SimulatedKill)) throw err;
    }
  };
  sim.engine.createRun();
  await step(() => sim.engine.loop());
  for (; steps < 25; steps++) {
    const s = sim.engine.s;
    if (
      RUN_TERMINAL.includes(s.state) ||
      s.state === 'READY_FOR_HUMAN_MERGE' ||
      s.state === 'PUSH_BLOCKED'
    )
      break;
    sim.failFn = () => {};
    if (s.state === 'ESCALATION_REQUIRED') {
      const rec = s.escalations[s.open_escalation as string];
      if (!rec) {
        await step(() => resumeSim(sim));
        continue;
      }
      const option = pick(rec.options as any[]).id as string;
      const d = decision(rec.id, option, option === 'mark_human_verified' ? 'AC-1' : undefined);
      await step(() => resumeSim(sim, { decision: d }));
      continue;
    }
    // A paused or crashed run: time passes, things clear, and it resumes.
    sim.clock.advance(4 * 3_600_000);
    for (const rung of Object.keys(sim.policy.workers.rungs)) sim.adapter.setProbe(rung, 'ok');
    await step(() => resumeSim(sim, { extendBudget: 1000, acceptPolicy: false }));
  }
  const evs = events(sim);
  return {
    sim,
    steps,
    ended: sim.engine.s.state,
    violations: evs.filter((e) => e.type === 'invariant.violation').map((e) => e.data),
  };
}
