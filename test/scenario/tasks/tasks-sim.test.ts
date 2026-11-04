import { describe, expect, it } from 'vitest';
import { makeSim, ofType, runSim } from '../../support/harness.ts';

describe('task flow on the in-memory world', () => {
  it('takes a 3-task run through to MOCK_RUN_COMPLETE', async () => {
    const sim = makeSim();
    const exit = await runSim(sim);
    expect(sim.engine.s.reason).toContain('mock');
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    for (const t of ['T1', 'T2', 'T3']) expect(sim.engine.s.tasks[t].state).toBe('TASK_PASSED');
    expect(ofType(sim, 'invariant.violation')).toEqual([]);
    expect(sim.engine.s.integration.merged.sort()).toEqual(['T1', 'T2', 'T3']);
  });
  it('holds a dependent until its dependency has passed, then branches from its commit', async () => {
    const sim = makeSim();
    await runSim(sim);
    const t1 = sim.engine.s.tasks.T1;
    const t3 = sim.engine.s.tasks.T3;
    expect(t3.base_commit).toBe(t1.commit);
  });
  it('writes every task commit by the coordinator, with its tree equal to the reviewed snapshot', async () => {
    const sim = makeSim();
    await runSim(sim);
    for (const t of ['T1', 'T2', 'T3']) {
      const rec = sim.engine.s.tasks[t];
      const snap = rec.snapshots[rec.snapshots.length - 1];
      expect(await sim.git.treeOf(rec.commit as string)).toBe(snap.tree);
      expect(rec.reviews[rec.reviews.length - 1].tree).toBe(snap.tree);
    }
  });
});
