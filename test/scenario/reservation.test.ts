import { describe, expect, it } from 'vitest';
import { SimulatedKill } from '../../src/core/ports.ts';
import { reservedFamilies } from '../../src/core/selectors.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { makeSim, ofType, resumeSim, runSim } from '../support/harness.ts';

const RULE = 'R-C2-RESERVATION';
const plan: any = {
  tasks: [
    {
      task_id: 'T1',
      goal: 'g',
      lane: 'implementation',
      allowed_paths: ['a/**'],
      forbidden_paths: [],
      acceptance_criteria: ['AC-1'],
      required_tests: [],
      depends_on: [],
    },
    {
      task_id: 'T2',
      goal: 'g',
      lane: 'research',
      allowed_paths: ['b/**'],
      forbidden_paths: [],
      acceptance_criteria: [],
      required_tests: [],
      depends_on: [],
    },
    {
      task_id: 'T3',
      goal: 'g',
      lane: 'hard-code',
      allowed_paths: ['c/**'],
      forbidden_paths: [],
      acceptance_criteria: [],
      required_tests: [],
      depends_on: [],
    },
  ],
  proposed_risk: 'low',
  spec_defects: [],
};
// Three lanes whose first rungs are three different families, as the default ladders can be.
const threeFirstRungs = (p: any) => {
  p.workers.ladders.implementation = ['mock-openai', 'mock-glm', 'mock-anthropic'];
  p.workers.ladders.research = ['mock-glm', 'mock-openai', 'mock-anthropic'];
  p.workers.ladders['hard-code'] = ['mock-anthropic', 'mock-openai', 'mock-glm'];
};
const slow = (task: string) => ({
  match: { task, step: 'work' as const },
  behaviour: 'ok' as const,
  delay_ms: 10_000,
});

describe('atomic family reservation', () => {
  it('three parallel tasks, all in flight: the third skips a rung, and integrated review stays possible', async () => {
    const sim = makeSim({
      plan,
      policy: threeFirstRungs,
      script: [slow('T1'), slow('T2'), slow('T3')],
    });
    const exit = await runSim(sim);
    const used = new Set(
      sim.adapter.log.filter((x) => x.step === 'work').map((x) => sim.engine.family(x.rung)),
    );
    assertNotForbidden(
      RULE,
      used.size === 3,
      'all three families were taken, and the run stranded',
    );
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.adapter.log.find((x) => x.task === 'T3' && x.step === 'work')?.rung).not.toBe(
      'mock-anthropic',
    );
    const acceptance = sim.adapter.log.find((x) => x.step === 'acceptance');
    expect(used.has(sim.engine.family(acceptance?.rung as string))).toBe(false);
  });
  it('the reservation is the dispatch.intent: an open intent holds the family across a crash', async () => {
    const sim = makeSim({ plan, policy: threeFirstRungs, script: [slow('T1')] });
    let armed = true;
    sim.failFn = (n) => {
      if (
        armed &&
        n === 'after_intent_before_spawn' &&
        Object.values(sim.engine.s.attempts).some((a) => a.task_id === 'T1')
      ) {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    assertNotForbidden(
      RULE,
      !reservedFamilies(sim.engine.s).has('openai'),
      'an open intent held no reservation',
    );
    sim.failFn = () => {};
    expect((await resumeSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    expect(reservedFamilies(sim.engine.s).size).toBeGreaterThan(0);
  });
  it('a failed attempt with no snapshot releases only after the liveness check is clean', async () => {
    const sim = makeSim({
      plan,
      policy: threeFirstRungs,
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'outage', times: 1 }],
    });
    await runSim(sim);
    const order = ofType(sim, 'dispatch.orphans_swept').find(
      (e) => e.data.attempt_id === ofType(sim, 'reservation.released')[0].data.attempt_id,
    );
    const rel = ofType(sim, 'reservation.released')[0];
    expect(order).toBeTruthy();
    assertNotForbidden(
      RULE,
      (order?.seq as number) > rel.seq,
      'a family was released before its liveness check',
    );
  });
  it('a stranded dispatch waits for a release, then goes ahead', async () => {
    const sim = makeSim({
      plan,
      policy: threeFirstRungs,
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', delay_ms: 5000 },
        { match: { task: 'T2', step: 'work' }, behaviour: 'quota', delay_ms: 1000, times: 1 },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
  it('a reviewer, an adjudicator and the shadow reserve nothing', () => {
    const sim = makeSim();
    const s: any = sim.engine.s;
    s.attempts.A = { mode: 'read_only', family: 'openai', released: false, retained: false };
    expect(reservedFamilies(s).has('openai')).toBe(false);
  });
});
