import { describe, expect, it } from 'vitest';
import { events, type Sim } from '../../support/harness.ts';
import { type Fuzz, fuzzRun, requiredPairs } from '../../support/fuzz-run.ts';

const RUNS = Number(process.env.ECP_FUZZ_RUNS ?? 10_000);
const FROM = Number(process.env.ECP_FUZZ_FROM ?? 1);

describe('the hole test (AC-B)', () => {
  it(`${RUNS} seeded runs each reach a terminal or decision state, with no invariant violation`, async () => {
    const byEnd: Record<string, number> = {};
    const bad: string[] = [];
    const ran = new Set<string>();
    for (let seed = FROM; seed < FROM + RUNS; seed++) {
      let out: Fuzz;
      try {
        out = await fuzzRun(seed);
      } catch (err) {
        bad.push(`seed ${seed}: threw ${String(err).slice(0, 1600)}`);
        if (bad.length >= 8) break;
        continue;
      }
      byEnd[out.ended] = (byEnd[out.ended] ?? 0) + 1;
      for (const l of out.sim.adapter.log) ran.add(`${l.step}|${l.behaviour}`);
      if (out.violations.length)
        bad.push(`seed ${seed}: ${JSON.stringify(out.violations[0]).slice(0, 300)}`);
      if (
        out.steps >= 25 &&
        !['PAUSED_NO_WORKER', 'PAUSED_BUDGET', 'PAUSED_OPERATOR'].includes(out.ended)
      ) {
        bad.push(`seed ${seed}: never settled, in ${out.ended}`);
      }
      if (bad.length >= 8) break;
    }
    expect(bad, JSON.stringify(byEnd)).toEqual([]);
    // Mock review can't reach READY, so nothing should end there.
    expect(byEnd.READY_FOR_HUMAN_MERGE ?? 0).toBe(0);
    if (RUNS < 100) return;
    expect((byEnd.MOCK_RUN_COMPLETE ?? 0) + (byEnd.CANCELLED ?? 0)).toBeGreaterThan(RUNS * 0.2);
    // The fuzz has to reach all the kinds of ending, or it isn't exercising them.
    expect(byEnd.CANCELLED ?? 0).toBeGreaterThan(0);
    expect(byEnd.MOCK_RUN_COMPLETE ?? 0).toBeGreaterThan(0);
    // What ran, not what was scripted: a behaviour on a step the runs never reach proves nothing.
    if (RUNS >= 5000) expect(requiredPairs().filter((p) => !ran.has(p))).toEqual([]);
  }, 2_400_000);
  it('a seed replays exactly', async () => {
    const a = await fuzzRun(4242);
    const b = await fuzzRun(4242);
    const types = (s: Sim) => events(s).map((e) => e.type);
    expect(types(a.sim)).toEqual(types(b.sim));
  });
});
