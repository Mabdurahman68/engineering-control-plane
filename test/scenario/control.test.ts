import { describe, expect, it } from 'vitest';
import { makeSim, ofType, resumeSim, runSim } from '../support/harness.ts';

const wide: any = {
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
const challenge = {
  plan: wide,
  spec: { requested_depth: 'DEEP' as const },
  script: [
    {
      match: { task: 'T1', step: 'work' as const },
      behaviour: 'ok' as const,
      edits: [
        { path: 'src/a.txt', content: 'a\n' },
        { path: '.sim/fail/full', content: 'Error: x\n' },
      ],
    },
    { match: { task: 'T1', step: 'challenge' as const }, behaviour: 'challenge_file' as const },
    {
      match: { task: 'T1', step: 'adjudicate' as const },
      behaviour: 'adjudicate' as const,
      args: { ruling: 'waive' },
    },
  ],
};
const stages: [string, string, any][] = [
  ['planning', 'after:plan.intent', {}],
  ['work', 'after:dispatch.started', {}],
  ['gate', 'after:gate.intent', {}],
  ['review', 'after:review.intent', {}],
  ['challenge', 'after:challenge.requested', challenge],
  ['adjudication', 'after:disagreement.opened', challenge],
  ['merge', 'after:merge.intent', {}],
  ['acceptance', 'after:tree.identity_checked', {}],
  [
    'T-INT',
    'after:repair.requested',
    { script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 1 }] },
  ],
];

describe.each(stages)('operator control during %s', (_name, point, over) => {
  const arm = (sim: any, request: 'pause' | 'cancel') => {
    let armed = true;
    sim.failFn = (n: string) => {
      if (armed && n === point) {
        armed = false;
        sim.control = { request };
      }
    };
  };
  it('pause stops, leaves no process, and resumes to the same outcome', async () => {
    const sim = makeSim(over);
    arm(sim, 'pause');
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_OPERATOR');
    expect(exit.code).toBe(3);
    expect(sim.adapter.liveRuns()).toEqual([]);
    expect(sim.engine.s.resume_to).not.toContain('PAUSED');
    const end = await resumeSim(sim);
    expect(end.state).toBe('MOCK_RUN_COMPLETE');
    for (const a of Object.values(sim.engine.s.attempts))
      expect(a.swept || a.fenced, a.attempt_id).toBe(true);
  });
  it('cancel ends the run, cancels every task, and leaves no process', async () => {
    const sim = makeSim(over);
    arm(sim, 'cancel');
    const exit = await runSim(sim);
    expect(exit.state).toBe('CANCELLED');
    expect(exit.code).toBe(6);
    expect(sim.adapter.liveRuns()).toEqual([]);
    for (const t of Object.values(sim.engine.s.tasks)) expect(t.state).toBe('TASK_CANCELLED');
    for (const a of Object.values(sim.engine.s.attempts))
      expect(a.swept || a.fenced, a.attempt_id).toBe(true);
  });
});

describe('control details', () => {
  it('cancel during integration or verification writes merge.aborted', async () => {
    const sim = makeSim();
    let armed = true;
    sim.failFn = (n) => {
      if (armed && n === 'after:merge.done') {
        armed = false;
        sim.control = { request: 'cancel' };
      }
    };
    await runSim(sim);
    expect(ofType(sim, 'merge.aborted').length).toBe(1);
  });
  it('a pause request during a pause changes nothing', async () => {
    const sim = makeSim({
      policy: (p) => {
        p.settings.caps.run.invocations = 2;
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_BUDGET');
    sim.control = { request: 'pause' };
    const again = await resumeSim(sim);
    expect(again.state).toBe('PAUSED_BUDGET');
    expect(
      ofType(sim, 'operator.request_received').filter((e) => e.data.request === 'pause').length,
    ).toBe(0);
  });
  it('cancel works on a paused run', async () => {
    const sim = makeSim({
      policy: (p) => {
        p.settings.caps.run.invocations = 2;
      },
    });
    await runSim(sim);
    sim.control = { request: 'cancel' };
    expect((await resumeSim(sim)).state).toBe('CANCELLED');
  });
  it('a term-ignoring worker is still stopped on cancel', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'hang_ignores_term' }],
    });
    let armed = true;
    sim.failFn = (n) => {
      if (armed && n === 'after:dispatch.started' && sim.adapter.log.some((x) => x.task === 'T1')) {
        armed = false;
        sim.control = { request: 'cancel' };
      }
    };
    expect((await runSim(sim)).state).toBe('CANCELLED');
    expect(sim.adapter.liveRuns()).toEqual([]);
  });
});
