import { describe, expect, it } from 'vitest';
import { consistencyErrors } from '../../../src/review/consistency.ts';
import { assertNotForbidden } from '../../support/assert.ts';
import { failReport, finding, passReport } from '../../support/review-fixtures.ts';

const ctx = {
  scopeAcs: ['AC-1'],
  coveredAcs: [] as string[],
  changedFiles: ['a.ts'],
  requireFileCoverage: true,
};
const RULE = 'R-C1-CONSISTENCY';
// The forbidden outcome: code accepts an inconsistent review.
const mustReject = (r: any, c = ctx) =>
  assertNotForbidden(
    RULE,
    consistencyErrors(r, c).length === 0,
    'an inconsistent review was accepted',
  );

describe('verdict consistency', () => {
  it('accepts a consistent PASS and a consistent FAIL', () => {
    expect(consistencyErrors(passReport(), ctx)).toEqual([]);
    expect(consistencyErrors(failReport(), ctx)).toEqual([]);
  });
  it('rejects PASS with a failed criterion', () => {
    const r = passReport();
    r.criteria[0].verdict = 'FAIL';
    r.criteria[0].finding_refs = [];
    mustReject(r);
  });
  it('rejects a PASS over a properly linked failure', () => {
    // Everything but the verdict is consistent: a valid FAIL, relabelled.
    const r = failReport();
    r.verdict = 'PASS';
    mustReject(r);
  });
  it('rejects PASS with a failed semantic check', () => {
    const r = passReport();
    r.semantic_checks.security.verdict = 'FAIL';
    mustReject(r);
  });
  it('rejects PASS with a blocker finding', () => {
    const r = passReport();
    r.findings = [finding({ severity: 'blocker' })];
    mustReject(r);
  });
  it('rejects FAIL with no blocker or major', () => {
    const r = passReport();
    r.verdict = 'FAIL';
    mustReject(r);
    const minor = passReport();
    minor.verdict = 'FAIL';
    minor.findings = [finding({ severity: 'minor' })];
    mustReject(minor);
  });
  it('rejects an unlinked blocking finding', () => {
    const r = passReport();
    r.verdict = 'FAIL';
    r.findings = [finding()];
    mustReject(r);
  });
  it('rejects a failed criterion that cites nothing blocking', () => {
    const r = failReport();
    r.findings[0].severity = 'minor';
    mustReject(r);
  });
  it('rejects a finding_ref that does not exist', () => {
    const r = failReport();
    r.criteria[0].finding_refs = [7];
    mustReject(r);
  });
  it('requires every in-scope criterion exactly once, and nothing else', () => {
    const r = passReport();
    r.criteria = [];
    mustReject(r);
    const dup = passReport();
    dup.criteria.push({ ...dup.criteria[0] });
    mustReject(dup);
    const extra = passReport(['AC-1', 'AC-9']);
    mustReject(extra);
  });
  it('requires every changed file in looked_at.files', () => {
    const r = passReport(['AC-1'], []);
    mustReject(r);
    expect(consistencyErrors(r, { ...ctx, requireFileCoverage: false })).toEqual([]);
  });
});

describe('unverifiable criteria', () => {
  const unverifiable = () => {
    const r = passReport();
    r.criteria[0].verdict = 'UNVERIFIABLE';
    return r;
  };
  it('rejects an uncovered UNVERIFIABLE in a PASS', () => {
    mustReject(unverifiable());
  });
  it('allows a covered UNVERIFIABLE in a PASS', () => {
    expect(consistencyErrors(unverifiable(), { ...ctx, coveredAcs: ['AC-1'] })).toEqual([]);
  });
  it('accepts the exact case: one UNVERIFIABLE, one major finding, all semantics PASS, verdict FAIL', () => {
    const r = unverifiable();
    r.verdict = 'FAIL';
    r.findings = [finding()];
    r.criteria[0].finding_refs = [0];
    expect(consistencyErrors(r, ctx)).toEqual([]);
  });
  it('rejects that case with the finding uncited', () => {
    const r = unverifiable();
    r.verdict = 'FAIL';
    r.findings = [finding()];
    mustReject(r);
  });
});
