import { describe, expect, it } from 'vitest';
import { applyClaimReview, reconcileClaims } from '../../../src/claims/reconcile.ts';
import { assertNotForbidden } from '../../support/assert.ts';

const git: any = { readFile: async () => 'exists\n', listTracked: async () => ['README.md'] };
async function record(claim: any) {
  const r = await reconcileClaims({
    taskId: 'T1',
    attempt: 1,
    rung: 'r',
    spec: { required_tests: [] } as never,
    requiredTests: [],
    report: { claims: [claim], tests_run_claimed: [] },
    includeWorkerClaims: true,
    git,
    commit: 'c',
    changed: [],
    results: [],
  });
  return r.claims.find((c) => c.claim === claim.claim) as any;
}
const semantic = {
  claim: 'the implementation is secure',
  type: 'FACT',
  value: true,
  verifier: { kind: 'file_exists', spec: { path: 'README.md' } },
};

describe('a claim only a reviewer can settle', () => {
  it('stays unverified, whatever verifier it cites', async () => {
    const c = await record(semantic);
    assertNotForbidden('R-CLAIMS', c.final === 'VERIFIED', 'a file existing verified a claim');
    expect(c.final).toBe('UNVERIFIED');
    expect(c.mechanical.status).toBe('NOT_APPLICABLE');
  });
  it('a reviewer PASS with a reason verifies it', async () => {
    const c = await record(semantic);
    const next = applyClaimReview(
      c,
      { status: 'PASS', reason: 'see src/auth.ts:12', corrected_value: null },
      'rev',
    );
    expect(next?.final).toBe('VERIFIED');
    expect(next?.independent_review).toMatchObject({ status: 'PASS', reviewer: 'rev' });
  });
  it('a PASS whose reason names no evidence verifies nothing', async () => {
    const c = await record(semantic);
    for (const reason of ['checked', 'looks right to me', '']) {
      const next = applyClaimReview(c, { status: 'PASS', reason, corrected_value: null }, 'rev');
      assertNotForbidden('R-CLAIMS', next?.final === 'VERIFIED', `verified on: ${reason}`);
    }
  });
  it("a digit in a sentence doesn't make a claim measurable", async () => {
    const c = await record({ ...semantic, claim: 'version 2 is secure' });
    assertNotForbidden('R-CLAIMS', c.final === 'VERIFIED', 'a file existing verified a claim');
    expect(c.mechanical.status).toBe('NOT_APPLICABLE');
  });
  it('a correction that agrees with what code measured stands', async () => {
    const c = await record({
      claim: 'it has 5 files',
      type: 'COUNT',
      value: 5,
      verifier: { kind: 'file_count', spec: { prefix: '' } },
    });
    expect(c.final).toBe('REJECTED');
    const next = applyClaimReview(c, { status: 'FAIL', reason: 'no', corrected_value: 1 }, 'rev');
    expect(next?.final).toBe('CORRECTED');
    const wrong = applyClaimReview(c, { status: 'FAIL', reason: 'no', corrected_value: 9 }, 'rev');
    expect(wrong?.final).toBe('REJECTED');
  });
  it('a reviewer FAIL rejects it, or corrects it when it gives the value', async () => {
    const c = await record(semantic);
    const none = { status: 'FAIL', reason: 'no', corrected_value: null } as const;
    expect(applyClaimReview(c, none, 'rev')?.final).toBe('REJECTED');
    expect(applyClaimReview(c, { ...none, corrected_value: false }, 'rev')?.final).toBe(
      'CORRECTED',
    );
  });
  it('NOT_REVIEWED changes nothing', async () => {
    const c = await record(semantic);
    expect(
      applyClaimReview(c, { status: 'NOT_REVIEWED', reason: '', corrected_value: null }, 'rev'),
    ).toBeNull();
  });
});

describe('what a reviewer cannot do', () => {
  it('overrule mechanical evidence', async () => {
    const c = await record({
      claim: 'README exists',
      type: 'FILE_EXISTS',
      value: true,
      verifier: { kind: 'file_exists', spec: { path: 'README.md' } },
    });
    expect(c.final).toBe('VERIFIED');
    const next = applyClaimReview(
      c,
      { status: 'FAIL', reason: 'no', corrected_value: false },
      'rev',
    );
    expect(next?.final).toBe('VERIFIED');
    expect(next?.independent_review.status).toBe('FAIL');
  });
  it('mark a number with no verifier as verified', async () => {
    const c = await record({ claim: 'there are 85 rows', type: 'FACT', value: null });
    expect(c.final).toBe('UNVERIFIED');
    const next = applyClaimReview(
      c,
      { status: 'PASS', reason: 'looks fine', corrected_value: null },
      'rev',
    );
    assertNotForbidden('R-CLAIMS', next?.final === 'VERIFIED', 'a model verified a number');
  });
  it('a measurable FACT with a verifier is still measured', async () => {
    const c = await record({
      claim: 'it has 1 file',
      type: 'FACT',
      value: 1,
      verifier: { kind: 'file_count', spec: { prefix: '' } },
    });
    expect(c.mechanical.status).toBe('VERIFIED');
  });
});
