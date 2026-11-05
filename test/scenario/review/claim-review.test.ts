import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../../support/assert.ts';
import { makeSim, ofType, runSim } from '../../support/harness.ts';

const RULE = 'R-CLAIMS';
const CLAIM = 'C-T1-1-3';
const tidy = {
  claims: [{ claim: 'the code is tidy', type: 'FACT', value: null }],
  tests_run_claimed: [],
};
const verdict = (reason = 'see src/t1/T1-1.txt:1') => ({
  claims_reviewed: [{ claim_id: CLAIM, status: 'PASS', reason, corrected_value: null }],
});
const finalOf = (sim: any, id: string): any => {
  const records = ofType(sim, 'claim.recorded').filter((e: any) => e.data.claim.claim_id === id);
  return records.at(-1)?.data.claim;
};
const work = { match: { task: 'T1', step: 'work' }, behaviour: 'ok', report: tidy };

describe('a reviewer on a claim', () => {
  it('the task review, with a reference, verifies the claim', async () => {
    const sim: any = makeSim({
      script: [
        work,
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_pass', args: verdict() },
      ] as never,
    });
    await runSim(sim);
    const c = finalOf(sim, CLAIM);
    expect(c.claim).toBe('the code is tidy');
    expect(c.final).toBe('VERIFIED');
    expect(c.independent_review.status).toBe('PASS');
  });
  it('gets the claim IDs in its brief', async () => {
    const sim: any = makeSim({ script: [work] as never });
    await runSim(sim);
    const briefs = ofType(sim, 'review.intent').map(
      (e: any) => sim.store.read(`attempts/${e.data.attempt_id}/brief.txt`) ?? '',
    );
    const brief = briefs.find(
      (b: string) => b.startsWith('You are an independent reviewer') && b.includes(CLAIM),
    );
    expect(brief).toBeTruthy();
  });
  it("another task's review can't touch it", async () => {
    const sim: any = makeSim({
      script: [
        work,
        { match: { task: 'T2', step: 'review' }, behaviour: 'reviewer_pass', args: verdict() },
      ] as never,
    });
    await runSim(sim);
    assertNotForbidden(
      RULE,
      finalOf(sim, CLAIM).final === 'VERIFIED',
      "another task's review verified it",
    );
  });
  it('the family that made a claim can never verify it, at integrated level either', async () => {
    const sim: any = makeSim({
      spec: { requested_depth: 'DEEP' },
      script: [
        work,
        {
          match: { step: 'acceptance' },
          behaviour: 'reviewer_pass',
          args: verdict(),
        },
      ] as never,
      policy: (p: any) => {
        // The writer's family reviews the integrated result.
        p.workers.ladders.review = ['mock-openai', 'mock-anthropic', 'mock-glm'];
      },
    });
    await runSim(sim);
    const c = finalOf(sim, CLAIM);
    const author = sim.engine.family(c.asserted_by);
    const reviewer = c.independent_review.reviewer;
    assertNotForbidden(
      RULE,
      reviewer !== null && sim.engine.family(reviewer) === author,
      'its own family reviewed it',
    );
  });
});
