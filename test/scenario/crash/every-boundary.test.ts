import { describe, expect, it } from 'vitest';
import { SimulatedKill } from '../../../src/core/ports.ts';
import { makeSim, resumeSim, runSim } from '../../support/harness.ts';

const wideFirst = {
  tasks: [
    {
      task_id: 'T1',
      goal: 'g',
      lane: 'implementation',
      allowed_paths: ['**'],
      forbidden_paths: [],
      acceptance_criteria: ['AC-1'],
      required_tests: [],
      depends_on: [],
    },
    {
      task_id: 'T2',
      goal: 'g',
      lane: 'implementation',
      allowed_paths: ['other/**'],
      forbidden_paths: [],
      acceptance_criteria: [],
      required_tests: [],
      depends_on: ['T1'],
    },
  ],
  proposed_risk: 'low',
  spec_defects: [],
};
const softFail = { path: '.sim/fail/full', content: 'Error: regression\n' };
const SCENARIOS: Record<string, any> = {
  happy: {},
  'review fail, then repair': {
    script: [{ match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 }],
  },
  'hard gate, then repair': {
    script: [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'ok',
        edits: [
          { path: 'src/t1/a.txt', content: 'a\n' },
          { path: '.sim/fail/unit', content: 'Error: unit\n' },
        ],
        times: 1,
      },
      {
        match: { task: 'T1', step: 'repair' },
        behaviour: 'ok',
        edits: [
          { path: 'src/t1/a.txt', content: 'b\n' },
          { path: '.sim/fail/unit', content: null },
        ],
        times: 1,
      },
    ],
    plan: {
      tasks: [
        {
          task_id: 'T1',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['**'],
          forbidden_paths: [],
          acceptance_criteria: ['AC-1'],
          required_tests: ['unit'],
          depends_on: [],
        },
        {
          task_id: 'T2',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['other/**'],
          forbidden_paths: [],
          acceptance_criteria: [],
          required_tests: [],
          depends_on: ['T1'],
        },
      ],
      proposed_risk: 'low',
      spec_defects: [],
    },
  },
  'secret: non-repairable': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret' }],
  },
  'outage, retry': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'outage', times: 1 }],
  },
  'auth, next rung': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'auth', times: 1 }],
  },
  'malformed report': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'malformed_report', times: 1 }],
  },
  'malformed review': {
    script: [
      { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_inconsistent', times: 1 },
    ],
  },
  'reviewer changes tree': {
    script: [
      { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_modifies_tree', times: 1 },
    ],
  },
  'acceptance fail': {
    script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 1 }],
  },
  'plan invalid, then valid': {
    script: [
      { match: { step: 'plan' }, behaviour: 'planner_invalid', args: { kind: 'cycle' }, times: 1 },
    ],
  },
  'spec defect': { script: [{ match: { step: 'plan' }, behaviour: 'planner_spec_defect' }] },
  'plan review fails once, DEEP': {
    spec: { requested_depth: 'DEEP' },
    script: [{ match: { step: 'plan_review' }, behaviour: 'reviewer_fail', times: 1 }],
  },
  'dispute overridden': {
    script: [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'ok',
        edits: [{ path: 'src/t1/a.txt', content: 'a\n' }],
      },
      {
        match: { task: 'T1', step: 'review' },
        behaviour: 'reviewer_fail',
        args: { findings: [{ file: 'src/t1/a.txt' }] },
        times: 1,
      },
      {
        match: { task: 'T1', step: 'repair' },
        behaviour: 'dispute_finding',
        edits: [
          { path: 'src/t1/a.txt', content: 'a\n' },
          { path: 'src/t1/b.txt', content: 'b\n' },
        ],
        times: 1,
      },
      {
        match: { task: 'T1', step: 'adjudicate' },
        behaviour: 'adjudicate',
        args: { ruling: 'override' },
      },
    ],
  },
  'soft gate challenged and waived, DEEP': {
    spec: { requested_depth: 'DEEP' },
    plan: wideFirst,
    script: [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'ok',
        edits: [{ path: 'src/a.txt', content: 'a\n' }, softFail],
      },
      { match: { task: 'T1', step: 'challenge' }, behaviour: 'challenge_file' },
      {
        match: { task: 'T1', step: 'adjudicate' },
        behaviour: 'adjudicate',
        args: { ruling: 'waive' },
      },
    ],
    expect: (sim: any) => {
      expect(sim.engine.s.waivers.length).toBeGreaterThan(0);
      expect(
        Object.values<any>(sim.engine.s.disagreements).some(
          (d) => d.kind === 'GATE_FAIL_AGENT_CHALLENGE',
        ),
      ).toBe(true);
    },
  },
  'merge conflict resolved': {
    prep: (sim: any) => {
      const merge = sim.git.mergeTrees.bind(sim.git);
      // The same merge conflicts every time it's tried, as a real one does.
      sim.git.mergeTrees = (a: string, b: string) => {
        if (sim.engine.s.tasks.T2?.commit === b) sim.git.conflictOn = 'src/t2/conflict.txt';
        return merge(a, b);
      };
    },
    script: [
      {
        match: { task: 'T-INT-1', step: 'work' },
        behaviour: 'resolver_ok',
        edits: [{ path: 'src/t2/conflict.txt', content: 'resolved\n' }],
      },
    ],
    expect: (sim: any) => {
      expect(sim.engine.s.tasks['T-INT-1']?.state).toBe('TASK_PASSED');
    },
  },
  'repair no change: stall, switch, escalate': {
    script: [
      { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail' },
      { match: { task: 'T1', step: 'repair' }, behaviour: 'no_change' },
    ],
  },
  'quota: next rung': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'quota', times: 1 }],
  },
  'rate limit: next rung': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'rate_limit', times: 1 }],
  },
  'timeout: retry': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'timeout', times: 1 }],
  },
  'crash midway: relay lost': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'crash_midway', times: 1 }],
  },
  'review outage: retry': {
    script: [{ match: { task: 'T1', step: 'review' }, behaviour: 'outage', times: 1 }],
  },
  'review quota: next rung': {
    script: [{ match: { task: 'T1', step: 'review' }, behaviour: 'quota', times: 1 }],
  },
  'adjudication split': {
    script: [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'ok',
        edits: [{ path: 'src/t1/a.txt', content: 'a\n' }],
      },
      {
        match: { task: 'T1', step: 'review' },
        behaviour: 'reviewer_fail',
        args: { findings: [{ file: 'src/t1/a.txt' }] },
        times: 1,
      },
      {
        match: { task: 'T1', step: 'repair' },
        behaviour: 'dispute_finding',
        edits: [
          { path: 'src/t1/a.txt', content: 'a\n' },
          { path: 'src/t1/b.txt', content: 'b\n' },
        ],
        times: 1,
      },
      {
        match: { task: 'T1', step: 'adjudicate' },
        behaviour: 'adjudicate',
        args: { ruling: 'split' },
      },
    ],
  },
  'task split at critical risk': {
    spec: { declared_risk: 'critical', requested_depth: 'EXHAUSTIVE' },
    script: [
      {
        match: { task: 'T1', step: 'review', rung: 'mock-anthropic' },
        behaviour: 'reviewer_pass',
        times: 1,
      },
      {
        match: { task: 'T1', step: 'review', rung: 'mock-glm' },
        behaviour: 'reviewer_fail',
        times: 1,
      },
    ],
    expect: (sim: any) => {
      expect(sim.engine.s.state).toBe('ESCALATION_REQUIRED');
      expect(
        Object.values<any>(sim.engine.s.disagreements).some((d) => d.kind === 'REVIEWER_REVIEWER'),
      ).toBe(true);
    },
  },
  'integrated split at high risk': {
    spec: { declared_risk: 'high' },
    policy: (p: any) => {
      p.profiles.quorum.high = 2;
    },
    script: [
      {
        match: { step: 'acceptance', rung: 'mock-anthropic' },
        behaviour: 'reviewer_pass',
        times: 1,
      },
      { match: { step: 'acceptance', rung: 'mock-glm' }, behaviour: 'reviewer_fail', times: 1 },
    ],
  },
};

function signature(sim: ReturnType<typeof makeSim>) {
  const s = sim.engine.s;
  return {
    state: s.state,
    reason:
      s.state === 'ESCALATION_REQUIRED' ? Object.values<any>(s.escalations).at(-1)?.reason : null,
    escalations: Object.values<any>(s.escalations).map((x) => `${x.reason}:${x.task_id}`),
    tasks: Object.fromEntries(Object.values(s.tasks).map((t) => [t.task_id, t.state])),
    merged: [...s.integration.merged].sort(),
    repairs: Object.fromEntries(Object.values(s.tasks).map((t) => [t.task_id, t.repairs])),
    switches: Object.fromEntries(
      Object.values(s.tasks).map((t) => [t.task_id, t.repair_rung_switches]),
    ),
    stalls: Object.fromEntries(Object.values(s.tasks).map((t) => [t.task_id, t.stalls])),
    adjudications: Object.fromEntries(
      Object.values(s.tasks).map((t) => [t.task_id, t.adjudications]),
    ),
    integrated_repairs: s.integrated_repairs,
    // Multiplicity and scope count, and so do who ruled and how.
    waivers: s.waivers
      .map((w: any) => {
        const authority = w.disagreement_id ? s.disagreements[w.disagreement_id] : null;
        const who = authority
          ? `${authority.kind}:${authority.adjudication.adjudicator}`
          : w.disagreement_id;
        return `${w.scope}|${JSON.stringify(w.resolves)}|${who}|${w.tree_at_ruling}`;
      })
      .sort(),
    disagreements: Object.values<any>(s.disagreements)
      .map(
        (d) =>
          `${d.kind}|${d.subject.task_id}|${d.filed_by}|${d.adjudication.status}|${d.adjudication.adjudicator}`,
      )
      .sort(),
    quarantined: Object.entries(s.quarantine)
      .map(([r, q]: any) => `${r}:${q.reason}`)
      .sort(),
    backoff: Object.fromEntries(Object.entries(s.backoff).map(([r, b]: any) => [r, b.tries])),
    risk: s.risk,
  };
}

// Whatever the crash, no attempt may be left unswept, and no reservation left open with no attempt.
function safetyProblems(sim: ReturnType<typeof makeSim>): string[] {
  const out: string[] = [];
  for (const a of Object.values(sim.engine.s.attempts)) {
    if (a.finished && !a.swept && !a.fenced) out.push(`${a.attempt_id} finished but never swept`);
    if (a.finished && sim.adapter.liveRuns().includes(a.attempt_id))
      out.push(`${a.attempt_id} finished, with its process alive`);
    if (a.class !== null && a.mode === 'write' && !a.retained && !a.released)
      out.push(`${a.attempt_id} holds a stale reservation`);
  }
  return out;
}

async function drive(sim: ReturnType<typeof makeSim>, first: () => Promise<unknown>) {
  await first();
}

describe.each(Object.keys(SCENARIOS))('crash at every ledger event: %s', (name) => {
  it('reaches the same end as the uninterrupted run', async () => {
    const baseline = makeSim(SCENARIOS[name]);
    await runSim(baseline);
    SCENARIOS[name].expect?.(baseline);
    expect(safetyProblems(baseline)).toEqual([]);
    const want = signature(baseline);
    const total = baseline.ledger.content.split('\n').filter(Boolean).length;
    const failures: string[] = [];
    for (let k = 1; k <= total; k++) {
      const sim = makeSim(SCENARIOS[name]);
      let seen = 0;
      sim.failFn = (n) => {
        if (n.includes('#') || !n.startsWith('after:')) return;
        seen++;
        if (seen === k) throw new SimulatedKill(n);
      };
      let crashedAt = '';
      try {
        await drive(sim, () => runSim(sim));
      } catch (err) {
        if (!(err instanceof SimulatedKill)) throw err;
        crashedAt = err.message;
      }
      if (!crashedAt) break;
      sim.failFn = () => {};
      await resumeSim(sim);
      failures.push(...safetyProblems(sim).map((x) => `#${k} ${crashedAt}: ${x}`));
      const got = signature(sim);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        const diff = Object.keys(got).filter(
          (x) => JSON.stringify((got as any)[x]) !== JSON.stringify((want as any)[x]),
        );
        failures.push(
          `#${k} ${crashedAt}: ${diff.map((x) => `${x}=${JSON.stringify((got as any)[x])}`).join(' ')}`,
        );
      }
      if (sim.engine.s.state === 'FAILED')
        failures.push(`#${k} ${crashedAt}: FAILED: ${sim.engine.s.reason}`);
    }
    expect(failures.slice(0, 6), `want ${JSON.stringify(want)}`).toEqual([]);
  });
});
