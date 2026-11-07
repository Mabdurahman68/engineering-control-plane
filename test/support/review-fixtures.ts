import { SEMANTIC_CHECKS } from '../../src/contracts/index.ts';
import type { ReviewReport } from '../../src/contracts/index.ts';

export const SEMANTIC = Object.fromEntries(
  SEMANTIC_CHECKS.map((n) => [n, { verdict: 'PASS', note: 'ok', finding_refs: [] }]),
) as any;

export function passReport(acs = ['AC-1'], files = ['a.ts']): ReviewReport {
  return {
    verdict: 'PASS',
    criteria: acs.map((ac) => ({ ac, verdict: 'PASS', evidence: 'e', finding_refs: [] })),
    semantic_checks: structuredClone(SEMANTIC),
    findings: [],
    claims_reviewed: [],
    looked_at: { files, commands: [], not_examined: [] },
  } as ReviewReport;
}

export const finding = (over: Record<string, unknown> = {}) =>
  ({
    criterion: 'AC-1',
    category: 'logic',
    finding_type: 'wrong_behaviour',
    subject: 'the subject',
    observed: 'what was seen',
    expected: 'what should be',
    severity: 'major',
    file: 'a.ts',
    line: null,
    message: 'm',
    required_repair: 'r',
    ...over,
  }) as any;

export function failReport(
  over: Partial<ReviewReport> = {},
  acs = ['AC-1'],
  files = ['a.ts'],
): ReviewReport {
  const r = passReport(acs, files);
  r.verdict = 'FAIL';
  r.findings = [finding()];
  r.criteria[0].verdict = 'FAIL';
  r.criteria[0].finding_refs = [0];
  return { ...r, ...over };
}
