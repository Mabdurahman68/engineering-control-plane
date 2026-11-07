import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '../../src/contracts/index.ts';
import { predictedDefect, shadowReportSchema } from '../../src/contracts/index.ts';
import { stallKey } from '../../src/review/fingerprint.ts';
import { matchPrediction } from '../../src/shadow/predictions.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { makeSim, ofType, runSim } from '../support/harness.ts';

const RULE = 'B3-PREDICTION';
const ev = (seq: number, type: any, data: any, task_id: string | null = 'T1'): LedgerEvent => ({
  schema: 'event.v1',
  seq,
  at: '2026-01-01T00:00:00Z',
  run_id: 'r',
  task_id,
  type,
  data,
  prev: '',
  hash: 'x',
});

// The worked example from contracts §15, used as the fixture.
const EXAMPLE = {
  action: 'repair',
  target: 'T1',
  reason: 'The retry path has no test, and the backoff looks unbounded.',
  confidence: 'medium',
  evidence_refs: { fingerprints: [], signatures: [], artifacts: ['evidence/T1/test-1.json'] },
  predicted_defects: [
    {
      kind: 'finding',
      horizon: 'next_review',
      criterion: 'AC-2',
      category: 'logic',
      finding_type: 'wrong_behaviour',
      subject: 'unbounded retry backoff',
      file: 'src/queue.ts',
      gate_id: null,
      failing_test: null,
      error_contains: null,
    },
  ],
  alternatives: [
    { action: 'proceed_to_review', why_not: 'The reviewer may miss the missing limit.' },
  ],
};
const laterFinding = {
  criterion: 'AC-2',
  category: 'logic',
  finding_type: 'wrong_behaviour',
  subject: 'Unbounded  retry backoff',
  file: 'src/queue.ts',
  line: 42,
  observed: 'delay doubles with no cap',
  expected: 'delay capped at 30s',
  severity: 'major',
};
const withKey = (f: any) => ({
  ...f,
  stall_key: stallKey(f),
  fingerprint: `${stallKey(f)}|anchor|digest`,
});

describe('the worked example', () => {
  it('is schema-valid', () => {
    expect(shadowReportSchema.safeParse(EXAMPLE).error).toBeUndefined();
  });
  it('derives the stall key from the prediction, and reaches exact_match with nothing injected', () => {
    const p = predictedDefect.parse(EXAMPLE.predicted_defects[0]);
    const after = [ev(212, 'review.collected', { findings: [withKey(laterFinding)] })];
    const r = matchPrediction(p, 0, after, 'T1');
    expect(r.predicted_stall_key).toBe(
      'AC-2|src/queue.ts|logic|wrong_behaviour|unbounded retry backoff',
    );
    assertNotForbidden(RULE, r.status !== 'exact_match', 'the worked example did not match');
    expect(r.matched).toEqual({
      fingerprint: withKey(laterFinding).fingerprint,
      signature: null,
      evidence_seq: 212,
    });
  });
  it('goes end to end, through a run', async () => {
    const edits = [{ path: 'src/t1/a.txt', content: 'a\n' }];
    const finding = {
      ...EXAMPLE.predicted_defects[0],
      kind: 'finding',
      horizon: 'next_review',
      subject: 'unbounded retry backoff',
      file: 'src/t1/a.txt',
      criterion: 'AC-1',
    };
    const sim = makeSim({
      shadow: true,
      script: [
        {
          match: { step: 'shadow', point: 'DP-GATES', task: 'T1' },
          behaviour: 'shadow_predict',
          args: { action: 'repair', target: 'T1', defect: finding },
          times: 1,
        },
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits },
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_fail',
          args: {
            findings: [
              {
                criterion: 'AC-1',
                category: 'logic',
                finding_type: 'wrong_behaviour',
                subject: 'Unbounded  retry backoff',
                file: 'src/t1/a.txt',
                observed: 'no cap',
                expected: 'a cap',
              },
            ],
          },
          times: 1,
        },
      ],
    });
    await runSim(sim);
    const resolved = ofType(sim, 'shadow.outcome_resolved').find(
      (e) => (e.data.predictions as any[]).length > 0,
    );
    assertNotForbidden(RULE, !resolved, 'no prediction was resolved');
    expect(((resolved as any).data.predictions as any[])[0].status).toBe('exact_match');
    expect(resolved?.data.label).toBe('CONSISTENT_WITH_SHADOW');
    expect(resolved?.data.rule).toBe('repair_vs_proceed_with_prediction');
  });
});

describe('matching rules', () => {
  const p = predictedDefect.parse(EXAMPLE.predicted_defects[0]);
  it('a novel defect absent from the bundle still matches', () => {
    expect(
      matchPrediction(
        p,
        0,
        [ev(1, 'review.collected', { findings: [withKey(laterFinding)] })],
        'T1',
      ).status,
    ).toBe('exact_match');
  });
  it('a different subject is near_match, which sets no label', () => {
    const r = matchPrediction(
      p,
      0,
      [
        ev(1, 'review.collected', {
          findings: [withKey({ ...laterFinding, subject: 'something else' })],
        }),
      ],
      'T1',
    );
    assertNotForbidden(RULE, r.status === 'exact_match', 'near was treated as exact');
    expect(r.status).toBe('near_match');
  });
  it('horizon reached with no match is not_observed', () => {
    expect(matchPrediction(p, 0, [ev(1, 'review.collected', { findings: [] })], 'T1').status).toBe(
      'not_observed',
    );
  });
  it('a run that ends first is horizon_not_reached', () => {
    expect(matchPrediction(p, 0, [ev(1, 'heartbeat', {})], 'T1').status).toBe(
      'horizon_not_reached',
    );
  });
  it('post_merge has no owner record, so is horizon_not_reached', () => {
    const late = predictedDefect.parse({ ...EXAMPLE.predicted_defects[0], horizon: 'post_merge' });
    expect(
      matchPrediction(late, 0, [ev(1, 'run.state_changed', { to: 'MOCK_RUN_COMPLETE' })], 'T1')
        .status,
    ).toBe('horizon_not_reached');
  });
  const gate = (o: any) =>
    predictedDefect.parse({
      kind: 'gate_failure',
      horizon: 'next_gate',
      gate_id: 'H-TESTS-PASS',
      failing_test: null,
      error_contains: null,
      ...o,
    });
  const gateEvent = ev(1, 'gate.finished', {
    results: [
      {
        id: 'H-TESTS-PASS',
        status: 'FAIL',
        signature: 'sig',
        normalised: ['Error: retry_test failed at line 3'],
      },
    ],
  });
  it('gate predictions match on gate ID and text', () => {
    expect(
      matchPrediction(gate({ error_contains: 'retry_test failed' }), 0, [gateEvent], 'T1').status,
    ).toBe('exact_match');
    expect(matchPrediction(gate({ failing_test: 'retry_test' }), 0, [gateEvent], 'T1').status).toBe(
      'exact_match',
    );
    expect(
      matchPrediction(gate({ error_contains: 'other text' }), 0, [gateEvent], 'T1').status,
    ).toBe('near_match');
  });
  it('a gate prediction with no discriminator is near_match at most', () => {
    const r = matchPrediction(gate({}), 0, [gateEvent], 'T1');
    assertNotForbidden(RULE, r.status === 'exact_match', 'a gate ID alone reached exact_match');
    expect(r.status).toBe('near_match');
  });
  it('a gate that passed is not a match', () => {
    const passed = ev(1, 'gate.finished', {
      results: [{ id: 'H-TESTS-PASS', status: 'PASS', normalised: [] }],
    });
    expect(matchPrediction(gate({ error_contains: 'x' }), 0, [passed], 'T1').status).toBe(
      'not_observed',
    );
  });
});
