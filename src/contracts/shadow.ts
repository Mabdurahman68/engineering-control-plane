import { z } from 'zod';
import { hex40, hex64, risk, usageRecord } from './common.ts';
import { FINDING_CATEGORIES, FINDING_TYPES } from './review.ts';

export const SHADOW_ACTIONS = [
  'proceed_to_review',
  'accept_task',
  'repair',
  'repair_next_rung',
  'retry_same_rung',
  'next_rung',
  'wait',
  'pause',
  'request_challenge',
  'adjudicate',
  'waive',
  'override',
  'replan',
  'integrate',
  'reverify',
  'mark_ready',
  'push',
  'hold_push',
  'escalate',
  'abandon',
  'other',
] as const;
export const shadowAction = z.enum(SHADOW_ACTIONS);
export type ShadowAction = z.infer<typeof shadowAction>;

export const DECISION_POINTS = [
  'DP-PLAN',
  'DP-GATES',
  'DP-REVIEW',
  'DP-REPAIR',
  'DP-DISAGREEMENT',
  'DP-FALLBACK',
  'DP-VERIFY',
  'DP-ESCALATE',
  'DP-PUBLISH',
] as const;
export const decisionPoint = z.enum(DECISION_POINTS);
export type DecisionPoint = z.infer<typeof decisionPoint>;

export const HORIZONS = [
  'next_gate',
  'next_review',
  'task_end',
  'integration',
  'run_end',
  'post_merge',
] as const;

const findingPrediction = z.strictObject({
  kind: z.literal('finding'),
  horizon: z.enum(HORIZONS),
  criterion: z.string(),
  category: z.enum(FINDING_CATEGORIES),
  finding_type: z.enum(FINDING_TYPES),
  subject: z.string().trim().min(1),
  file: z.string().nullable(),
  gate_id: z.null().optional(),
  failing_test: z.null().optional(),
  error_contains: z.null().optional(),
});
const gatePrediction = z.strictObject({
  kind: z.literal('gate_failure'),
  horizon: z.enum(HORIZONS),
  gate_id: z.string(),
  failing_test: z.string().nullable(),
  error_contains: z.string().nullable(),
  criterion: z.null().optional(),
  category: z.null().optional(),
  finding_type: z.null().optional(),
  subject: z.null().optional(),
  file: z.null().optional(),
});
export const predictedDefect = z.discriminatedUnion('kind', [findingPrediction, gatePrediction]);
export type PredictedDefect = z.infer<typeof predictedDefect>;

export const shadowReportSchema = z
  .strictObject({
    schema: z.literal('shadow_report.v1').optional(),
    action: shadowAction,
    target: z.string().nullable(),
    reason: z.string(),
    confidence: z.enum(['low', 'medium', 'high']),
    evidence_refs: z.strictObject({
      fingerprints: z.array(z.string()),
      signatures: z.array(z.string()),
      artifacts: z.array(z.string()),
    }),
    predicted_defects: z.array(predictedDefect),
    alternatives: z.array(z.strictObject({ action: shadowAction, why_not: z.string() })),
  })
  .refine((r) => r.action !== 'other' || r.reason.trim().length > 0, {
    message: 'action other requires a reason',
  });
export type ShadowReport = z.infer<typeof shadowReportSchema>;

export const shadowProposalSchema = z.strictObject({
  schema: z.literal('shadow_proposal.v1'),
  decision_id: z.string().regex(/^DP-\d+$/),
  point: decisionPoint,
  task_id: z.string().nullable(),
  risk,
  input_sha: hex64,
  subject_tree: hex40.nullable(),
  coordinator: z.strictObject({
    action: shadowAction,
    target: z.string().nullable(),
    transition: z.strictObject({ from: z.string(), to: z.string() }),
    refs: z.strictObject({ fingerprints: z.array(z.string()), signatures: z.array(z.string()) }),
  }),
  shadow: z.strictObject({
    status: z.enum(['RECORDED', 'SHADOW_UNAVAILABLE', 'SHADOW_SKIPPED_BUDGET']),
    unavailable_class: z.string().nullable(),
    rung_id: z.string().nullable(),
    model_requested: z.string().nullable(),
    model_reported: z.string().nullable(),
    family: z.string().nullable(),
    family_relation: z.enum(['different', 'same_family_different_model']).nullable(),
    session_id: z.string().nullable(),
    report: shadowReportSchema.nullable(),
    mock: z.boolean(),
  }),
  comparison: z.strictObject({
    match: z.boolean().nullable(),
    match_rule: z.enum(['action_and_target', 'action_only']),
    proposal_legal: z.boolean().nullable(),
    would_violate: z.array(z.string()),
  }),
  outcome: z.strictObject({
    observed: z.strictObject({
      predictions: z.array(
        z.strictObject({
          index: z.number().int(),
          predicted_stall_key: z.string().nullable(),
          status: z.enum(['exact_match', 'near_match', 'not_observed', 'horizon_not_reached']),
          matched: z.strictObject({
            fingerprint: z.string().nullable(),
            signature: z.string().nullable(),
            evidence_seq: z.number().int().nullable(),
          }),
        }),
      ),
      horizon_reached: z.boolean(),
      label: z.enum(['CONSISTENT_WITH_COORDINATOR', 'CONSISTENT_WITH_SHADOW', 'UNDETERMINED']),
      rule: z.string().nullable(),
    }),
    owner_preference: z.strictObject({
      decision_id: z.string().nullable(),
      option_id: z.string().nullable(),
      aligned_with: z.enum(['coordinator', 'shadow', 'neither']).nullable(),
      new_information: z.boolean().nullable(),
      authority_exercised: z.boolean().nullable(),
    }),
    counterfactual: z.strictObject({
      status: z.enum(['NOT_TESTED', 'REPLAYED', 'NOT_REPLAYABLE']),
      replay_id: z.string().nullable(),
    }),
  }),
  usage: usageRecord,
});
export type ShadowProposal = z.infer<typeof shadowProposalSchema>;
