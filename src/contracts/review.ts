import { z } from 'zod';
import { hex40, hex64, nonEmpty } from './common.ts';

export const SEMANTIC_CHECKS = [
  'spec_fidelity',
  'architecture',
  'security',
  'test_adequacy',
  'merge_compat',
] as const;
export type SemanticCheck = (typeof SEMANTIC_CHECKS)[number];

const semanticCheck = z.strictObject({
  verdict: z.enum(['PASS', 'FAIL']),
  note: z.string(),
  finding_refs: z.array(z.number().int()),
});

export const FINDING_CATEGORIES = [
  'spec',
  'logic',
  'security',
  'test',
  'architecture',
  'performance',
  'other',
] as const;
export const FINDING_TYPES = [
  'wrong_behaviour',
  'missing_code',
  'missing_test',
  'unsafe',
  'contract_break',
  'other',
] as const;
export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

export const reviewFinding = z.strictObject({
  criterion: z.string(),
  category: z.enum(FINDING_CATEGORIES),
  finding_type: z.enum(FINDING_TYPES),
  subject: nonEmpty,
  observed: nonEmpty,
  expected: nonEmpty,
  severity: z.enum(SEVERITIES),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  message: z.string(),
  required_repair: z.string(),
});
export type ReviewFinding = z.infer<typeof reviewFinding>;

export const computedFinding = z.strictObject({
  ...reviewFinding.shape,
  stall_key: z.string(),
  anchor: z.string(),
  defect_digest: z.string(),
  fingerprint: z.string(),
});
export type ComputedFinding = z.infer<typeof computedFinding>;

const modelFields = {
  verdict: z.enum(['PASS', 'FAIL']),
  criteria: z.array(
    z.strictObject({
      ac: z.string(),
      verdict: z.enum(['PASS', 'FAIL', 'UNVERIFIABLE']),
      evidence: z.string(),
      finding_refs: z.array(z.number().int()),
    }),
  ),
  semantic_checks: z.strictObject({
    spec_fidelity: semanticCheck,
    architecture: semanticCheck,
    security: semanticCheck,
    test_adequacy: semanticCheck,
    merge_compat: semanticCheck,
  }),
  claims_reviewed: z.array(
    z.strictObject({
      claim_id: z.string(),
      status: z.enum(['PASS', 'FAIL', 'NOT_REVIEWED']),
      reason: z.string(),
      corrected_value: z.unknown().nullable(),
    }),
  ),
  looked_at: z.strictObject({
    files: z.array(z.string()),
    commands: z.array(z.string()),
    not_examined: z.array(z.strictObject({ store: z.string(), reason: z.string() })),
  }),
};

// The model-written part. `schema` is optional here, as for every agent report.
export const reviewReportSchema = z.strictObject({
  schema: z.literal('review_report.v1').optional(),
  ...modelFields,
  findings: z.array(reviewFinding),
});
export type ReviewReport = z.infer<typeof reviewReportSchema>;

export const REVIEW_KINDS = ['task', 'integrated', 'plan', 'adjudication'] as const;

export const reviewSchema = z.strictObject({
  schema: z.literal('review.v1'),
  review_id: nonEmpty,
  subject: z.strictObject({
    kind: z.enum(REVIEW_KINDS),
    id: z.string(),
    commit_or_tree: z.string(),
  }),
  reviewer: z.strictObject({
    rung_id: z.string(),
    adapter: z.string(),
    model_requested: z.string(),
    model_reported: z.string().nullable(),
    family: z.string(),
    session_id: z.string().nullable(),
  }),
  independence: z.strictObject({
    authors: z.array(z.string()),
    reviewer_family: z.string(),
    independent: z.boolean(),
    family_source: z.enum(['registry_assertion', 'reported_model']),
  }),
  subject_tree: hex40,
  inputs: z.strictObject({
    spec_sha: hex64,
    task_sha: hex64.nullable(),
    diff_sha: hex64.nullable(),
    plan_sha: hex64.nullable(),
    evidence_shas: z.array(hex64),
  }),
  ...modelFields,
  findings: z.array(computedFinding),
  mock: z.boolean(),
});
export type Review = z.infer<typeof reviewSchema>;
