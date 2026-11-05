import { describe, expect, it } from 'vitest';
import { makeSim, resumeSim, runSim } from '../../support/harness.ts';

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

async function settle(sim: any) {
  let exit = await runSim(sim);
  for (let i = 0; i < 5 && exit.state.startsWith('PAUSED_'); i++) {
    sim.clock.advance(4 * 3_600_000);
    exit = await resumeSim(sim);
  }
  return exit;
}

describe('every failure class at the challenge step', () => {
  it.each([
    ['malformed_report', 2],
    ['no_report', 2],
    ['unknown_failure', 2],
    ['outage', 2],
    ['timeout', 2],
    ['relay_lost', 2],
    ['quota', 1],
    ['auth', 1],
    ['rate_limit', 4],
  ])('%s: at most %i calls, then the run goes on without a challenge', async (behaviour, most) => {
    const sim: any = makeSim({
      plan: wide,
      spec: deep,
      script: [{ match: { task: 'T1', step: 'challenge' }, behaviour }, ...base] as never,
    });
    const exit = await settle(sim);
    const made = calls(sim, 'challenge');
    expect(made.length).toBeGreaterThan(0);
    expect(made.length).toBeLessThanOrEqual(most);
    expect(exit.state).not.toBe('PAUSED_BUDGET');
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(calls(sim, 'repair').length).toBe(1);
  });
  it('a permanently malformed challenge retries once, then is treated as none filed', async () => {
    const sim: any = makeSim({
      plan: wide,
      spec: deep,
      script: [
        { match: { task: 'T1', step: 'challenge' }, behaviour: 'malformed_report' },
        ...base,
      ] as never,
    });
    const exit = await runSim(sim);
    expect(calls(sim, 'challenge').length).toBe(2);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
});

describe('every failure class at the adjudication step', () => {
  it.each([
    'malformed_report',
    'unknown_failure',
    'outage',
    'timeout',
    'relay_lost',
    'quota',
    'auth',
    'rate_limit',
  ])('%s reaches an answer, or the owner, and never loops', async (behaviour) => {
    const sim: any = makeSim({
      plan: wide,
      spec: deep,
      script: [
        { match: { task: 'T1', step: 'challenge' }, behaviour: 'challenge_file' },
        { match: { task: 'T1', step: 'adjudicate' }, behaviour, times: 1 },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'reject' },
        },
        ...base,
      ] as never,
    });
    const exit = await settle(sim);
    expect(calls(sim, 'adjudicate').length).toBeGreaterThan(0);
    expect(calls(sim, 'adjudicate').length).toBeLessThanOrEqual(4);
    expect(exit.state).not.toBe('PAUSED_BUDGET');
  });
});
