import { describe, expect, it } from 'vitest';
import { computeFigures } from '../../src/report/figures.ts';
import { assertNotForbidden } from '../support/assert.ts';

const claim = (final: string) => ({
  claim_id: 'C-T1-1-1',
  claim: 'the code is tidy',
  final,
  mechanical: { status: 'NOT_APPLICABLE', observed: null },
});
const ev = (seq: number, type: string, data: unknown) =>
  ({ seq, type, data, task_id: 'T1' }) as never;

describe('figures the ledger states twice, or not at all', () => {
  it('a claim reviewed later counts once, at its latest state', () => {
    const f = computeFigures([
      ev(1, 'claim.recorded', { claim: claim('UNVERIFIED') }),
      ev(2, 'claim.recorded', { claim: claim('VERIFIED') }),
    ]);
    assertNotForbidden('AC-F', f.claims.unverified !== 0, 'a superseded record was counted');
    expect(f.claims.verified).toBe(1);
  });
  it('an invocation with no usage record still counts', () => {
    const f = computeFigures([
      ev(1, 'dispatch.finished', { attempt_id: 'A', wall_clock_s: 1 }),
      ev(2, 'dispatch.finished', { attempt_id: 'B', wall_clock_s: 1 }),
      ev(3, 'usage.recorded', { attempt_id: 'A', tokens: 'unavailable', cost_usd: 2 }),
    ]);
    assertNotForbidden('AC-F', f.usage.total !== 2, `the denominator is ${f.usage.total}`);
    assertNotForbidden('AC-F', f.usage.cost_usd !== 2, `the cost is ${f.usage.cost_usd}`);
  });
});
