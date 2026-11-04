import { describe, expect, it } from 'vitest';
import { SimulatedKill } from '../../../src/core/ports.ts';
import { makeSim, resumeSim, runSim } from '../../support/harness.ts';

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
    script: [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'ok',
        edits: [{ path: 'src/t1/a.txt', content: 'a\n' }],
      },
      { match: { task: 'T1', step: 'challenge' }, behaviour: 'challenge_file' },
      {
        match: { task: 'T1', step: 'adjudicate' },
        behaviour: 'adjudicate',
        args: { ruling: 'waive' },
      },
    ],
    softFail,
  },
  'merge conflict resolved': {
    plan: {
      tasks: [
        {
          task_id: 'T1',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['src/**'],
          forbidden_paths: [],
          acceptance_criteria: ['AC-1'],
          required_tests: [],
          depends_on: [],
        },
        {
          task_id: 'T2',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['src/**'],
          forbidden_paths: [],
          acceptance_criteria: [],
          required_tests: [],
          depends_on: ['T1'],
        },
      ],
      proposed_risk: 'low',
      spec_defects: [],
    },
    files: { 'README.md': 'x\n' },
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
    tasks: Object.fromEntries(Object.values(s.tasks).map((t) => [t.task_id, t.state])),
    merged: [...s.integration.merged].sort(),
    repairs: Object.fromEntries(Object.values(s.tasks).map((t) => [t.task_id, t.repairs])),
    integrated_repairs: s.integrated_repairs,
    waivers: [...new Set(s.waivers.map((w: any) => JSON.stringify(w.resolves)))].sort(),
    quarantined: Object.keys(s.quarantine).sort(),
    risk: s.risk,
  };
}

async function drive(sim: ReturnType<typeof makeSim>, first: () => Promise<unknown>) {
  await first();
}

describe.each(Object.keys(SCENARIOS))('crash at every ledger event: %s', (name) => {
  it('reaches the same end as the uninterrupted run', async () => {
    const baseline = makeSim(SCENARIOS[name]);
    await runSim(baseline);
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
