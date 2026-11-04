import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import * as c from '../../../src/contracts/index.ts';
import { publishBlock } from '../../../src/contracts/spec.ts';
import { shadowReport, VALID } from './fixtures.ts';

const SCHEMAS: Record<string, ZodType> = {
  spec: c.specSchema,
  task: c.taskSchema,
  result: c.resultSchema,
  claim: c.claimSchema,
  review: c.reviewSchema,
  review_report: c.reviewReportSchema,
  disagreement: c.disagreementSchema,
  waiver: c.waiverSchema,
  run_state: c.runStateSchema,
  event: c.eventSchema,
  profiles: c.profilesSchema,
  risk_rules: c.riskRulesSchema,
  worker_report: c.workerReportSchema,
  plan: c.planSchema,
  challenge: c.challengeSchema,
  ruling: c.rulingSchema,
  repair_brief: c.repairBriefSchema,
  escalation: c.escalationSchema,
  decision: c.decisionSchema,
  shadow_report: c.shadowReportSchema,
  shadow_proposal: c.shadowProposalSchema,
  workers: c.workersSchema,
  families: c.familiesSchema,
  failure_classes: c.failureClassesSchema,
  cli_versions: c.cliVersionsSchema,
  secret_patterns: c.secretPatternsSchema,
  settings: c.settingsSchema,
  publish_forbidden: c.publishForbiddenSchema,
  mock_script: c.mockScriptSchema,
  dispatch_request: c.dispatchRequest,
  health: c.healthSchema,
};
const OPTIONAL_KEYS = new Set([
  'expect_red_baseline',
  'gate_commands',
  'known_control_files',
  'allowed_control_paths',
  'publish',
  'probes',
  'rung',
  'target',
]);

describe.each(Object.keys(SCHEMAS))('contract %s', (name) => {
  const schema = SCHEMAS[name];
  const valid = VALID[name];
  it('accepts its valid fixture', () => {
    expect(schema.safeParse(valid).error).toBeUndefined();
  });
  it('rejects an unknown field', () => {
    expect(schema.safeParse({ ...valid, unexpected_field: 1 }).success).toBe(false);
  });
  it('rejects every missing required field', () => {
    const keys = Object.keys(valid).filter(
      (k) => !OPTIONAL_KEYS.has(k) || (name === 'decision' && k !== 'target'),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      if (key === 'schema' && valid.schema === undefined) continue;
      const copy = { ...valid };
      delete copy[key];
      expect(schema.safeParse(copy).success, `missing ${key}`).toBe(false);
    }
  });
});

describe('specific contract rules', () => {
  const crit = (o: object) => ({
    ...VALID.spec,
    acceptance_criteria: [{ id: 'AC-1', text: 't', ...o }],
  });
  it('rejects a non-reserved criterion with no verify entry', () => {
    expect(c.specSchema.safeParse(crit({})).success).toBe(false);
  });
  it('accepts a human-reserved criterion with no verify entry', () => {
    expect(c.specSchema.safeParse(crit({ human_reserved: true })).success).toBe(true);
  });
  it('rejects a hard gate as the subject of a waive request', () => {
    const d = {
      ...VALID.disagreement,
      subject: { task_id: 'T1', gate_id: 'H-SECRET', review_id: null },
    };
    expect(c.disagreementSchema.safeParse(d).success).toBe(false);
  });
  it('rejects an event type outside the frozen list', () => {
    expect(c.eventSchema.safeParse({ ...VALID.event, type: 'run.invented' }).success).toBe(false);
  });
  it('rejects empty subject, observed and expected on a finding', () => {
    for (const key of ['subject', 'observed', 'expected']) {
      const report = VALID.review_report as any;
      const bad = { ...report, findings: [{ ...report.findings[0], [key]: '  ' }] };
      expect(c.reviewReportSchema.safeParse(bad).success, key).toBe(false);
    }
  });
  it('rejects a typo in every publish field', () => {
    const p = {
      repo: 'o/n',
      remote_url: 'u',
      base_branch: 'main',
      base_commit: 'a'.repeat(40),
      visibility_expected: 'public',
      allowed_paths: ['src/**'],
    };
    expect(publishBlock.safeParse(p).success).toBe(true);
    for (const key of Object.keys(p)) {
      const copy: any = { ...p };
      delete copy[key];
      expect(publishBlock.safeParse(copy).success, key).toBe(false);
    }
    expect(publishBlock.safeParse({ ...p, extra: 1 }).success).toBe(false);
  });
  it('requires an action from the closed vocabulary, and a reason for other', () => {
    expect(c.shadowReportSchema.safeParse({ ...shadowReport, action: 'merge' }).success).toBe(
      false,
    );
    expect(
      c.shadowReportSchema.safeParse({ ...shadowReport, action: 'other', reason: ' ' }).success,
    ).toBe(false);
  });
  it('parses the worked example from contracts §15', () => {
    const example = {
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
    expect(c.shadowReportSchema.safeParse(example).error).toBeUndefined();
  });
});
