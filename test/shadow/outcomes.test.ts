import { describe, expect, it } from 'vitest';
import type { LedgerEvent, ShadowReport } from '../../src/contracts/index.ts';
import { observedOutcome, ownerPreference } from '../../src/shadow/outcome.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { decision, makeSim, ofType, resumeSim, runSim } from '../support/harness.ts';

const RULE = 'R-C6-OUTCOMES';
const ev = (seq: number, type: any, data: any): LedgerEvent => ({
  schema: 'event.v1',
  seq,
  at: '2026-01-01T00:00:00Z',
  run_id: 'r',
  task_id: 'T1',
  type,
  data,
  prev: '',
  hash: 'x',
});
const report = (o: Partial<ShadowReport>): ShadowReport =>
  ({
    action: 'repair',
    target: null,
    reason: 'r',
    confidence: 'low',
    evidence_refs: { fingerprints: [], signatures: [], artifacts: [] },
    predicted_defects: [],
    alternatives: [],
    ...o,
  }) as ShadowReport;

describe('observed-outcome rules', () => {
  it('repair vs escalate: REPAIR_EXHAUSTED favours the shadow; TASK_PASSED favours the coordinator', () => {
    const r = report({ action: 'escalate' });
    expect(
      observedOutcome('repair', r, true, 'T1', [
        ev(1, 'task.state_changed', {
          escalation_reason: 'REPAIR_EXHAUSTED',
          to: 'TASK_ESCALATED',
        }),
      ]).label,
    ).toBe('CONSISTENT_WITH_SHADOW');
    expect(
      observedOutcome('repair', r, true, 'T1', [ev(1, 'task.state_changed', { to: 'TASK_PASSED' })])
        .label,
    ).toBe('CONSISTENT_WITH_COORDINATOR');
  });
  const predicted = report({
    action: 'repair',
    predicted_defects: [
      {
        kind: 'finding',
        horizon: 'next_review',
        criterion: 'AC-1',
        category: 'logic',
        finding_type: 'wrong_behaviour',
        subject: 's',
        file: null,
      } as any,
    ],
  });
  it('proceed vs repair with a prediction: exact_match favours the shadow', () => {
    const key = 'AC-1||logic|wrong_behaviour|s';
    expect(
      observedOutcome('proceed_to_review', predicted, true, 'T1', [
        ev(1, 'review.collected', { findings: [{ stall_key: key, fingerprint: 'f' }] }),
      ]).label,
    ).toBe('CONSISTENT_WITH_SHADOW');
  });
  it('horizon reached with not_observed: provisionally the coordinator', () => {
    const out = observedOutcome('proceed_to_review', predicted, true, 'T1', [
      ev(1, 'review.collected', { findings: [] }),
    ]);
    expect(out.label).toBe('CONSISTENT_WITH_COORDINATOR');
    expect(out.rule).toContain('provisional');
  });
  it('an illegal proposal counts for the coordinator, always', () => {
    expect(observedOutcome('repair', report({ action: 'waive' }), false, 'T1', []).label).toBe(
      'CONSISTENT_WITH_COORDINATOR',
    );
  });
  it('next_rung versus wait stays UNDETERMINED', () => {
    const out = observedOutcome('next_rung', report({ action: 'wait' }), true, 'T1', [
      ev(1, 'task.state_changed', { to: 'TASK_PASSED' }),
    ]);
    assertNotForbidden(RULE, out.label !== 'UNDETERMINED', 'a fallback disagreement got a label');
  });
  it('an escalation stays UNDETERMINED', () => {
    expect(observedOutcome('escalate', report({ action: 'repair' }), true, 'T1', []).label).toBe(
      'UNDETERMINED',
    );
  });
  it('a near match sets no label', () => {
    const out = observedOutcome('proceed_to_review', predicted, true, 'T1', [
      ev(1, 'review.collected', {
        findings: [
          {
            stall_key: 'AC-1||logic|wrong_behaviour|other',
            criterion: 'AC-1',
            file: null,
            category: 'logic',
            finding_type: 'wrong_behaviour',
            fingerprint: 'f',
          },
        ],
      }),
    ]);
    assertNotForbidden(RULE, out.label !== 'UNDETERMINED', 'a near match set a label');
  });
});

describe('owner preference', () => {
  it('owner retry_task sets preference only, never an observed label', () => {
    const pref = ownerPreference('escalate', 'repair', {
      escalation_id: 'E-1',
      option_id: 'retry_task',
      new_information: true,
      authority_exercised: false,
    });
    expect(pref).toMatchObject({
      decision_id: 'E-1',
      option_id: 'retry_task',
      aligned_with: 'neither',
      new_information: true,
      authority_exercised: false,
    });
    const obs = observedOutcome('escalate', report({ action: 'repair' }), true, 'T1', [
      ev(1, 'operator.decision', { option_id: 'retry_task' }),
    ]);
    assertNotForbidden(
      RULE,
      obs.label !== 'UNDETERMINED',
      'an owner decision set an observed label',
    );
  });
  it('none is null', () => {
    expect(ownerPreference('a', 'b', null).aligned_with).toBeNull();
  });
  it('new_information reaches the record, through a run', async () => {
    const sim = makeSim({
      shadow: true,
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret', times: 1 }],
    });
    await runSim(sim);
    const d = {
      ...decision(sim.engine.s.open_escalation as string, 'retry_task'),
      new_information: true,
    };
    await resumeSim(sim, { decision: d });
    const withOwner = ofType(sim, 'shadow.outcome_resolved').filter(
      (e) => e.data.new_information === true,
    );
    expect(withOwner.length).toBeGreaterThan(0);
    for (const e of withOwner)
      expect(['UNDETERMINED', 'CONSISTENT_WITH_COORDINATOR']).toContain(e.data.label);
  });
});

describe('counterfactual', () => {
  it('stays NOT_TESTED until a replay', async () => {
    const sim = makeSim({
      shadow: true,
      script: [
        { match: { step: 'shadow' }, behaviour: 'shadow_disagree', args: { action: 'escalate' } },
      ],
    });
    await runSim(sim);
    const id = ofType(sim, 'shadow.recorded')[0].data.decision_id;
    const rec = JSON.parse(sim.store.read(`shadow/${id}.json`) as string);
    expect(rec.outcome.counterfactual).toEqual({ status: 'NOT_TESTED', replay_id: null });
  });
});
