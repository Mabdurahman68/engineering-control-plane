import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../../support/assert.ts';
import { makeSim, ofType, resumeSim, runSim } from '../../support/harness.ts';

describe('reviewer independence', () => {
  it('a same-family reviewer is never dispatched', async () => {
    const sim = makeSim();
    await runSim(sim);
    for (const t of ['T1', 'T2', 'T3']) {
      for (const r of sim.engine.s.tasks[t].reviews) {
        expect(sim.engine.s.tasks[t].retained_families).not.toContain(r.family);
      }
    }
  });
  it('an unknown family is refused as a reviewer', async () => {
    const sim = makeSim({
      policy: (p) => {
        p.workers.rungs.stranger = {
          adapter: 'mock',
          model: 'nobody-knows',
          auth_mode: 'subscription',
          credential_env: [],
        };
        p.workers.ladders.review = ['stranger', 'mock-anthropic'];
      },
    });
    await runSim(sim);
    expect(sim.adapter.log.some((x) => x.rung === 'stranger')).toBe(false);
  });
  it('a reported model of another family invalidates the review', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reported_family_mismatch', times: 1 },
      ],
    });
    await runSim(sim);
    const inv = ofType(sim, 'review.invalid');
    expect(inv.length).toBe(1);
    expect(inv[0].data.reason).toContain('reported model');
  });
  it('authors in two families use the third; with none, the run pauses', async () => {
    const twoAuthors: any[] = [
      { match: { task: 'T1', step: 'work' }, behaviour: 'rate_limit', times: 1 },
    ];
    const sim = makeSim({ script: twoAuthors });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const t1 = sim.engine.s.tasks.T1;
    expect(t1.retained_families).toEqual(['glm']);
    expect(t1.reviews[0].family).not.toBe('glm');
  });
  it('the reviewer never changes after a FAIL', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 2 }],
    });
    await runSim(sim);
    const rungs = sim.engine.s.tasks.T1.reviews.map((r) => r.rung);
    expect(new Set(rungs).size).toBe(1);
  });
  it('a malformed rung is reset before a rung change, so its tree never reaches a reviewer', async () => {
    const sim = makeSim({
      script: [
        {
          match: { task: 'T1', step: 'work', rung: 'mock-openai' },
          behaviour: 'malformed_report',
          edits: [{ path: 'src/t1/poison.txt', content: 'x\n' }],
        },
      ],
    });
    await runSim(sim);
    const t1 = sim.engine.s.tasks.T1;
    expect(t1.retained_families).toEqual(['glm']);
    const snap = t1.snapshots[t1.snapshots.length - 1];
    expect(await sim.git.readFile(snap.commit, 'src/t1/poison.txt')).toBeNull();
  });
  it('a malformed re-ask on the same rung keeps the diff', async () => {
    const sim = makeSim({
      script: [
        {
          match: { task: 'T1', step: 'work', attempt: 1 },
          behaviour: 'malformed_report',
          edits: [{ path: 'src/t1/keep.txt', content: 'x\n' }],
        },
        { match: { task: 'T1', step: 'work', attempt: 2 }, behaviour: 'ok', edits: [] },
      ],
    });
    await runSim(sim);
    const t1 = sim.engine.s.tasks.T1;
    expect(await sim.git.readFile(t1.snapshots[0].commit, 'src/t1/keep.txt')).toBe('x\n');
  });
  it('NO_REVIEWER_FAMILY pauses, and adding a family lets it resume', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T2', step: 'work', rung: 'mock-openai' }, behaviour: 'quota', times: 1 },
      ],
      policy: (p) => {
        p.workers.ladders.review = ['mock-anthropic', 'mock-openai'];
        p.workers.ladders.adversarial = ['mock-anthropic', 'mock-openai'];
        p.workers.ladders.implementation = ['mock-openai', 'mock-anthropic'];
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_NO_WORKER');
    expect(sim.engine.s.reason).toBe('NO_REVIEWER_FAMILY');
    assertNotForbidden(
      'R-INDEPENDENCE',
      sim.adapter.log.some((x) => x.task === 'T2' && x.rung === 'mock-anthropic'),
      'a rung that strands review was taken',
    );
    sim.policy.workers.ladders.review.push('mock-glm');
    sim.policy.workers.ladders.adversarial.push('mock-glm');
    sim.policy.workers.ladders.implementation.push('mock-glm');
    const again = await resumeSim(sim, { acceptPolicy: true });
    expect(again.state).toBe('MOCK_RUN_COMPLETE');
    expect(ofType(sim, 'run.resumed').at(-1)?.data.accept_policy).toBeTruthy();
  });
  it('the shadow is never counted toward a quorum', async () => {
    const sim = makeSim({ spec: { requested_depth: 'EXHAUSTIVE', declared_risk: 'critical' } });
    await runSim(sim);
    for (const r of sim.engine.s.tasks.T1.reviews) expect(r.rung).not.toContain('shadow');
    expect(sim.engine.s.tasks.T1.reviews.length).toBe(2);
    expect(new Set(sim.engine.s.tasks.T1.reviews.map((r) => r.rung)).size).toBe(2);
  });
});

describe('plan review independence', () => {
  it("excludes the planner's family", async () => {
    const sim = makeSim({ spec: { requested_depth: 'DEEP' } });
    await runSim(sim);
    const planner = sim.adapter.log.find((x) => x.step === 'plan')?.rung as string;
    const reviewer = sim.adapter.log.find((x) => x.step === 'plan_review')?.rung as string;
    expect(sim.engine.family(reviewer)).not.toBe(sim.engine.family(planner));
  });
});
