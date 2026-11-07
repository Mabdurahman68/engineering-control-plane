import { describe, expect, it } from 'vitest';
import {
  effectiveVerdict,
  reportHasOnlyUnverifiableFailures,
  waiverVoidCause,
} from '../../../src/review/effective.ts';
import { computeFinding } from '../../../src/review/fingerprint.ts';
import { assertNotForbidden } from '../../support/assert.ts';
import { failReport, finding, passReport } from '../../support/review-fixtures.ts';
import { makeSim, runSim } from '../../support/harness.ts';

const src = { tree: 't'.repeat(40), readFile: async () => 'x\n', blobId: async () => 'blob' };
const RULE = 'R-C1-EFFECTIVE';
const waiver = (fp: string, over: any = {}) => ({
  resolves: {
    gate_id: null,
    signature_element: null,
    finding_fingerprint: fp,
    criterion: null,
    semantic_check: null,
    ...over,
  },
});

async function twoCriteria() {
  const a = await computeFinding(finding({ criterion: 'AC-1', subject: 'first' }), src);
  const b = await computeFinding(finding({ criterion: 'AC-2', subject: 'second' }), src);
  const r: any = passReport(['AC-1', 'AC-2']);
  r.verdict = 'FAIL';
  r.findings = [a, b];
  r.criteria[0].verdict = 'FAIL';
  r.criteria[0].finding_refs = [0];
  r.criteria[1].verdict = 'FAIL';
  r.criteria[1].finding_refs = [1];
  return { r, a, b };
}

describe('effective verdict', () => {
  it('stays FAIL when one of two failed criteria is waived', async () => {
    const { r, a } = await twoCriteria();
    const e = effectiveVerdict(r, [waiver(a.fingerprint, { criterion: 'AC-1' })], []);
    assertNotForbidden(RULE, e.verdict === 'PASS', 'a partial waiver cleared the task');
    expect(e.unresolved.some((x) => x.startsWith('criterion:AC-2'))).toBe(true);
  });
  it('is PASS only when every failure is resolved by its own waiver', async () => {
    const { r, a, b } = await twoCriteria();
    const e = effectiveVerdict(
      r,
      [waiver(a.fingerprint, { criterion: 'AC-1' }), waiver(b.fingerprint, { criterion: 'AC-2' })],
      [],
    );
    expect(e.verdict).toBe('PASS');
  });
  it('a waiver for the finding, without its criterion, does not clear the criterion', async () => {
    const { r, a, b } = await twoCriteria();
    const e = effectiveVerdict(
      r,
      [waiver(a.fingerprint), waiver(b.fingerprint, { criterion: 'AC-2' })],
      [],
    );
    assertNotForbidden(RULE, e.verdict === 'PASS', 'the criterion cleared with no bound waiver');
  });
  it('a failed semantic check needs its own binding', async () => {
    const f = await computeFinding(finding({ criterion: 'none' }), src);
    const r: any = passReport();
    r.verdict = 'FAIL';
    r.findings = [f];
    r.semantic_checks.security.verdict = 'FAIL';
    r.semantic_checks.security.finding_refs = [0];
    assertNotForbidden(
      RULE,
      effectiveVerdict(r, [waiver(f.fingerprint)], []).verdict === 'PASS',
      'semantic cleared with no binding',
    );
    expect(
      effectiveVerdict(r, [waiver(f.fingerprint, { semantic_check: 'security' })], []).verdict,
    ).toBe('PASS');
  });
  it('a waiver for another identity covers nothing', async () => {
    const { r } = await twoCriteria();
    expect(effectiveVerdict(r, [waiver('other', { criterion: 'AC-1' })], []).verdict).toBe('FAIL');
  });
  it('a waiver cannot clear an uncovered UNVERIFIABLE; only coverage can', async () => {
    const f = await computeFinding(finding(), src);
    const r: any = passReport();
    r.verdict = 'FAIL';
    r.findings = [f];
    r.criteria[0].verdict = 'UNVERIFIABLE';
    r.criteria[0].finding_refs = [0];
    const w = waiver(f.fingerprint, { criterion: 'AC-1' });
    assertNotForbidden(
      RULE,
      effectiveVerdict(r, [w], []).verdict === 'PASS',
      'a waiver cleared an unverifiable criterion',
    );
    expect(effectiveVerdict(r, [w], ['AC-1']).verdict).toBe('PASS');
  });
  it('names why a waiver no longer applies', async () => {
    const a = await computeFinding(finding(), src);
    const reworded = await computeFinding(finding({ observed: 'said differently' }), src);
    const moved = await computeFinding(finding(), { ...src, blobId: async () => 'other' });
    expect(waiverVoidCause(reworded.fingerprint, [waiver(a.fingerprint)])).toBe('text_changed');
    expect(waiverVoidCause(moved.fingerprint, [waiver(a.fingerprint)])).toBe('anchor_changed');
    expect(waiverVoidCause(a.fingerprint, [waiver(a.fingerprint)])).toBeNull();
    expect(
      waiverVoidCause((await computeFinding(finding({ subject: 'else' }), src)).fingerprint, [
        waiver(a.fingerprint),
      ]),
    ).toBeNull();
  });
  it('recognises a review whose only failures are unverifiable criteria', () => {
    const r: any = passReport();
    r.verdict = 'FAIL';
    r.findings = [finding()];
    r.criteria[0].verdict = 'UNVERIFIABLE';
    r.criteria[0].finding_refs = [0];
    expect(reportHasOnlyUnverifiableFailures(r, [])).toBe(true);
    expect(reportHasOnlyUnverifiableFailures(r, ['AC-1'])).toBe(false);
    expect(reportHasOnlyUnverifiableFailures(failReport(), [])).toBe(false);
  });
});

describe('effective verdict in a run', () => {
  it('a partial waiver leaves the task in repair, end to end', async () => {
    const edits = [{ path: 'src/t1/a.txt', content: 'a\n' }];
    const f1 = { criterion: 'AC-1', file: 'src/t1/a.txt', subject: 'one' };
    const f2 = { criterion: 'AC-1', file: 'src/t1/a.txt', subject: 'two' };
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits },
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_fail',
          args: { findings: [f1, f2] },
          times: 2,
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'dispute_finding',
          args: { only_first: true },
          edits,
          times: 1,
        },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'override' },
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: 'src/t1/a.txt', content: 'fixed\n' }],
        },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const reviews = sim.engine.s.tasks.T1.reviews;
    expect(reviews[1].verdict).toBe('FAIL');
    assertNotForbidden(
      RULE,
      reviews[1].effective === 'PASS',
      'the task cleared on one of two waivers',
    );
    expect(sim.engine.s.tasks.T1.repairs).toBe(2);
  });
});
