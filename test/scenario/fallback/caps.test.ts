import { describe, expect, it } from 'vitest';
import { makeSim, ofType, resumeSim, runSim } from '../../support/harness.ts';

const cap =
  (k: string, v: number, where: 'run' | 'day' = 'run') =>
  (p: any) => {
    p.settings.caps[where][k] = v;
  };
const measured = {
  source: 'vendor_cli_result',
  tokens: { input: 10, output: 5, cached: 0 },
  cost_usd: 2,
  quota_snapshot: 'unavailable',
  wall_clock_s: 1,
} as const;

describe('spend caps', () => {
  it('invocation cap: pause, warn at 80%, and resume with --extend-budget', async () => {
    const sim = makeSim({ policy: cap('invocations', 5) });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_BUDGET');
    expect(exit.code).toBe(3);
    expect(sim.engine.s.counters.invocations).toBe(5);
    expect(ofType(sim, 'cap.warning').length).toBeGreaterThan(0);
    expect(ofType(sim, 'cap.reached').length).toBe(1);
    const stuck = await resumeSim(sim);
    expect(stuck.state).toBe('PAUSED_BUDGET');
    const end = await resumeSim(sim, { extendBudget: 100 });
    expect(end.state).toBe('MOCK_RUN_COMPLETE');
  });
  it('wall-clock cap', async () => {
    const sim = makeSim({
      policy: cap('wall_clock_s', 30),
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'ok', delay_ms: 60_000 }],
    });
    expect((await runSim(sim)).state).toBe('PAUSED_BUDGET');
  });
  it('USD cap, with measured data', async () => {
    const sim = makeSim({
      policy: cap('usd', 3),
      script: [{ match: {}, behaviour: 'ok', usage: measured, times: 2 }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_BUDGET');
    expect(sim.engine.s.usage.cost_usd).toBeGreaterThanOrEqual(3);
  });
  it('usage unavailable never counts as zero: coverage says so', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'ok', usage: measured }],
    });
    await runSim(sim);
    const u = sim.engine.s.usage;
    expect(u.measured).toBe(1);
    expect(u.total).toBeGreaterThan(u.measured);
    const unavailable = ofType(sim, 'usage.recorded').filter(
      (e) => e.data.tokens === 'unavailable',
    );
    expect(unavailable.length).toBe(u.total - u.measured);
    expect(unavailable.every((e) => e.data.cost_usd === 'unavailable')).toBe(true);
  });
  it('per-day totals count other runs', async () => {
    const sim = makeSim({ policy: cap('invocations', 6, 'day') });
    sim.ports.dayUsage = () => ({ invocations: 5, wall_clock_s: 0, usd: 0, shadow_invocations: 0 });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_BUDGET');
    expect(sim.engine.s.counters.invocations).toBe(1);
  });
  it('a pause keeps every review owed, and resuming owes the same', async () => {
    const sim = makeSim({ policy: cap('invocations', 4) });
    await runSim(sim);
    const end = await resumeSim(sim, { extendBudget: 100 });
    expect(end.state).toBe('MOCK_RUN_COMPLETE');
    for (const t of ['T1', 'T2', 'T3'])
      expect(sim.engine.s.tasks[t].reviews.length).toBeGreaterThan(0);
  });
});
