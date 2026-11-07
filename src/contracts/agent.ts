import { z } from 'zod';
import { excerptRef, glob, nonEmpty, risk } from './common.ts';
import { claimType, verifier } from './claim.ts';
import { lane } from './task.ts';

// Agent-written reports may omit `schema`: code knows which step it asked for and adds the name.
export const workerClaim = z.strictObject({
  claim: z.string(),
  type: claimType,
  value: z.unknown().optional(),
  verifier: verifier.optional(),
});
export const disputedFinding = z.strictObject({
  fingerprint: z.string(),
  reason: z.string(),
  evidence: z.array(excerptRef),
});

export const workerReportSchema = z.strictObject({
  schema: z.literal('worker_report.v1').optional(),
  status: z.enum(['done', 'blocked']),
  summary: z.string(),
  claims: z.array(workerClaim),
  tests_run_claimed: z.array(z.string()),
  known_issues: z.array(z.string()),
  disputed_findings: z.array(disputedFinding),
});
export type WorkerReport = z.infer<typeof workerReportSchema>;

export const planTask = z.strictObject({
  task_id: z.string().regex(/^[A-Za-z0-9-]+$/),
  goal: nonEmpty,
  lane,
  allowed_paths: z.array(glob).min(1),
  forbidden_paths: z.array(glob),
  acceptance_criteria: z.array(z.string()),
  required_tests: z.array(z.string()),
  depends_on: z.array(z.string()),
});
export const planSchema = z.strictObject({
  schema: z.literal('plan.v1').optional(),
  tasks: z.array(planTask),
  proposed_risk: risk,
  spec_defects: z.array(z.strictObject({ text: z.string(), evidence: z.string() })),
});
export type Plan = z.infer<typeof planSchema>;

export const challengeSchema = z.strictObject({
  schema: z.literal('challenge.v1').optional(),
  challenges: z.array(
    z.strictObject({
      gate_id: z.string(),
      signature: z.string(),
      agent_position: z.string(),
      reason: z.string(),
      evidence: z.array(excerptRef),
    }),
  ),
});
export type Challenge = z.infer<typeof challengeSchema>;

export const rulingSchema = z.strictObject({
  schema: z.literal('ruling.v1').optional(),
  ruling: z.enum(['WAIVE', 'OVERRIDE', 'REJECT', 'SPLIT']),
  reason: z.string(),
  evidence: z.array(excerptRef),
});
export type Ruling = z.infer<typeof rulingSchema>;

export const repairBriefSchema = z.strictObject({
  schema: z.literal('repair_brief.v1'),
  attempt: z.number().int(),
  findings: z.array(
    z.strictObject({
      fingerprint: z.string(),
      stall_key: z.string(),
      criterion: z.string(),
      severity: z.string(),
      file: z.string().nullable(),
      line: z.number().int().nullable(),
      message: z.string(),
      evidence: z.string(),
      required_repair: z.string(),
    }),
  ),
  gate_failures: z.array(
    z.strictObject({
      gate_id: z.string(),
      command: z.array(z.string()),
      signature: z.string(),
      log_tail: z.string(),
    }),
  ),
  contradicted_claims: z.array(
    z.strictObject({ claim_id: z.string(), claim: z.string(), observed: z.unknown() }),
  ),
  allowed_paths: z.array(glob),
});
export type RepairBrief = z.infer<typeof repairBriefSchema>;

export const ESCALATION_REASONS = [
  'SPEC_DEFECT',
  'PLAN_INVALID',
  'HARD_GATE_BREACH',
  'REPAIR_EXHAUSTED',
  'MERGE_CONFLICT',
  'UNRESOLVED_DISAGREEMENT',
  'UNVERIFIABLE_CRITERION',
  'HUMAN_IRREVERSIBLE_GATE',
] as const;
export const escalationReason = z.enum(ESCALATION_REASONS);
export type EscalationReason = z.infer<typeof escalationReason>;

export const escalationSchema = z.strictObject({
  schema: z.literal('escalation.v1'),
  id: z.string().regex(/^E-\d+$/),
  reason: escalationReason,
  task_id: z.string().nullable(),
  summary: z.string(),
  evidence: z.array(z.string()),
  options: z.array(z.strictObject({ id: z.string(), text: z.string(), consequence: z.string() })),
});
export type Escalation = z.infer<typeof escalationSchema>;

export const decisionSchema = z.strictObject({
  schema: z.literal('decision.v1'),
  escalation_id: z.string(),
  option_id: z.string(),
  note: z.string(),
  new_information: z.boolean(),
  authority_exercised: z.boolean(),
  decided_by: z.literal('owner'),
  // Which criterion a mark_human_verified covers, or which finding or gate a waive or override names.
  target: z.string().optional(),
});
export type Decision = z.infer<typeof decisionSchema>;
