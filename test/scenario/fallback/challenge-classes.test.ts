import { describe, expect, it } from 'vitest';
import { makeSim, runSim } from '../../support/harness.ts';

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
const deep = { requested_depth: 'DEEP' } as const;
const softEdits = [
  { path: 'src/a.txt', content: 'a\n' },
  { path: '.sim/fail/full', content: 'Error: regression\n' },
];
const fixed = [
  { path: 'src/a.txt', content: 'b\n' },
  { path: '.sim/fail/full', content: null },
];
const base = [
  { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits: softEdits },
  { match: { task: 'T1', step: 'repair' }, behaviour: 'ok', edits: fixed },
];
const calls = (sim: any, step: string) => sim.adapter.log.filter((l: any) => l.step === step);

describe('every failure class at the challenge step', () => {
  // Fallback policy §3: one retry for these. None for the rest, and the filer has no next rung.
  it.each([
    ['malformed_report', 2],
    ['no_report', 2],
    ['unknown_failure', 2],
    ['outage', 2],
    ['timeout', 2],
    ['relay_lost', 2],
    ['quota', 1],
    ['auth', 1],
    ['rate_limit', 1],
  ])(
    '%s: exactly %i calls, then none filed, and the task goes to repair',
    async (behaviour, exact) => {
      const sim: any = makeSim({
        plan: wide,
        spec: deep,
        script: [{ match: { task: 'T1', step: 'challenge' }, behaviour }, ...base] as never,
      });
      const exit = await runSim(sim);
      expect(calls(sim, 'challenge').map((c: any) => c.rung)).toEqual(
        Array(exact).fill('mock-openai'),
      );
      expect(exit.state).toBe('MOCK_RUN_COMPLETE');
      expect(calls(sim, 'repair').length).toBe(1);
    },
  );
});

const LADDER = ['mock-anthropic', 'mock-glm', 'mock-anthropic-2', 'mock-glm-2'];
const adjudicating = (behaviour: string, times?: number) =>
  makeSim({
    plan: wide,
    spec: deep,
    script: [
      { match: { task: 'T1', step: 'challenge' }, behaviour: 'challenge_file' },
      { match: { task: 'T1', step: 'adjudicate' }, behaviour, ...(times ? { times } : {}) },
      {
        match: { task: 'T1', step: 'adjudicate' },
        behaviour: 'adjudicate',
        args: { ruling: 'reject' },
      },
      ...base,
    ] as never,
  }) as any;

describe('every failure class at the adjudication step', () => {
  const once = ['malformed_report', 'unknown_failure', 'outage', 'timeout', 'relay_lost'];
  const never = ['quota', 'auth', 'rate_limit'];
  it.each(once)('%s once: the same rung retries, and rules', async (behaviour) => {
    const sim = adjudicating(behaviour, 1);
    const exit = await runSim(sim);
    expect(calls(sim, 'adjudicate').map((c: any) => c.rung)).toEqual(
      LADDER.slice(0, 1).concat(LADDER[0]),
    );
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
  it.each(never)('%s once: the next rung rules, with no retry', async (behaviour) => {
    const sim = adjudicating(behaviour, 1);
    const exit = await runSim(sim);
    expect(calls(sim, 'adjudicate').map((c: any) => c.rung)).toEqual(LADDER.slice(0, 2));
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
  it.each(once.filter((b) => b !== 'timeout'))(
    '%s every time: twice on each rung, then PAUSED_NO_WORKER',
    async (behaviour) => {
      const sim = adjudicating(behaviour);
      const exit = await runSim(sim);
      expect(calls(sim, 'adjudicate').map((c: any) => c.rung)).toEqual(
        LADDER.flatMap((r) => [r, r]),
      );
      expect(exit.state).toBe('PAUSED_NO_WORKER');
    },
  );
  it('timeout every time: twice on each rung, and the wall-clock cap stops it', async () => {
    const sim = adjudicating('timeout');
    const exit = await runSim(sim);
    expect(calls(sim, 'adjudicate').map((c: any) => c.rung)).toEqual(LADDER.flatMap((r) => [r, r]));
    expect(exit.state).toBe('PAUSED_BUDGET');
  });
  it.each(never)('%s every time: once on each rung, then PAUSED_NO_WORKER', async (behaviour) => {
    const sim = adjudicating(behaviour);
    const exit = await runSim(sim);
    expect(calls(sim, 'adjudicate').map((c: any) => c.rung)).toEqual(LADDER);
    expect(exit.state).toBe('PAUSED_NO_WORKER');
  });
});
