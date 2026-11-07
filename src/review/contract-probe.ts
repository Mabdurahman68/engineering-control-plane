import { reviewReportSchema } from '../contracts/index.ts';
import { consistencyErrors } from './consistency.ts';
import { parseBlock } from './report-block.ts';

export type ProbeInput = {
  relayShaOk: boolean;
  status: string | null;
  finalMessage: string;
  login: string;
  requestedModel: string;
  reportedModel: string | null;
  treeUnchanged: boolean;
};

const WRONG_OPERATOR = /subtract|minus|difference|operator|a\s*-\s*b|`-`/i;

// Checked by code and not by reading. A CLI that doesn't report a model passes that check: the events
// don't always carry one, so the flag being accepted is the most this can claim. A different one fails.
export function checkContractProbe(p: ProbeInput): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!p.relayShaOk) failed.push('relay hash');
  if (p.status !== 'completed') failed.push(`status ${p.status}`);
  if (!/Logged in using ChatGPT/.test(p.login)) failed.push('not a subscription login');
  if (p.reportedModel !== null && p.reportedModel !== p.requestedModel)
    failed.push(`served by ${p.reportedModel}`);
  if (!p.treeUnchanged) failed.push('the tree changed');
  const parsed = parseBlock(p.finalMessage, reviewReportSchema);
  if (!parsed.ok) {
    failed.push(`report: ${parsed.error}`);
    return { pass: false, failed };
  }
  const report: any = parsed.value;
  const errors = consistencyErrors(report, {
    scopeAcs: ['AC-1'],
    coveredAcs: [],
    changedFiles: ['add.js'],
    requireFileCoverage: true,
  });
  if (errors.length) failed.push(`inconsistent: ${errors.join('; ')}`);
  const named = report.findings.some(
    (f: any) =>
      (f.severity === 'blocker' || f.severity === 'major') &&
      f.file === 'add.js' &&
      WRONG_OPERATOR.test([f.subject, f.observed, f.expected, f.message].join(' ')),
  );
  if (report.verdict !== 'FAIL' || !named) failed.push('did not name the planted defect');
  return { pass: failed.length === 0, failed };
}
