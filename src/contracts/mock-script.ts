import { z } from 'zod';
import { usageRecord } from './common.ts';

export const MOCK_BEHAVIOURS = [
  'ok',
  'malformed_report',
  'no_report',
  'exit_nonzero',
  'rate_limit',
  'quota',
  'auth',
  'outage',
  'unknown_failure',
  'timeout',
  'hang_ignores_term',
  'crash_midway',
  'relay_lost',
  'edit_out_of_scope',
  'edit_control_file',
  'commit_head',
  'write_secret',
  'weaken_test',
  'claim_false_count',
  'claim_tests_passed_false',
  'no_change',
  'oscillate',
  'planner_valid',
  'planner_invalid',
  'planner_spec_defect',
  'spawn_failure',
  'resolver_ok',
  'resolver_fail',
  'reports_touched_files',
  'challenge_none',
  'challenge_file',
  'dispute_finding',
  'dispute_no_evidence',
  'probe',
  'reviewer_pass',
  'reviewer_fail',
  'reviewer_inconsistent',
  'gate_rewrites_tracked',
  'shadow_agree',
  'shadow_disagree',
  'shadow_illegal',
  'shadow_other',
  'shadow_predict',
  'shadow_malformed',
  'shadow_timeout',
  'shadow_quota',
  'shadow_auth',
  'shadow_slow',
  'shadow_crash',
  'reviewer_modifies_tree',
  'reviewer_incomplete',
  'reviewer_pass_with_blocker',
  'reported_family_mismatch',
  'adjudicate',
] as const;
export type MockBehaviour = (typeof MOCK_BEHAVIOURS)[number];

export const STEP_KINDS = [
  'plan',
  'plan_review',
  'work',
  'repair',
  'review',
  'challenge',
  'adjudicate',
  'acceptance',
  'adversarial',
  'lens',
  'shadow',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const scriptStep = z.strictObject({
  match: z.strictObject({
    task: z.string().optional(),
    step: z.enum(STEP_KINDS).optional(),
    attempt: z.number().int().optional(),
    rung: z.string().optional(),
    point: z.string().optional(),
  }),
  behaviour: z.enum(MOCK_BEHAVIOURS),
  // Free-form arguments of a behaviour such as planner_valid(tasks) or reviewer_fail(findings).
  args: z.unknown().optional(),
  edits: z.array(z.strictObject({ path: z.string(), content: z.string().nullable() })).optional(),
  report: z.record(z.string(), z.unknown()).optional(),
  session_id: z.string().optional(),
  usage: usageRecord.partial().optional(),
  delay_ms: z.number().int().nonnegative().optional(),
  times: z.number().int().positive().optional(),
  // Fake relay survives the coordinator's death (for the re-attach path).
  survives_coordinator: z.boolean().optional(),
});
export type ScriptStep = z.infer<typeof scriptStep>;

export const mockScriptSchema = z.strictObject({
  schema: z.literal('mock_script.v1'),
  rung: z.string().optional(),
  steps: z.array(scriptStep),
  probes: z
    .record(
      z.string(),
      z.enum(['ok', 'not_installed', 'bad_version', 'missing_flag', 'auth_no', 'quota_exhausted']),
    )
    .optional(),
});
export type MockScript = z.infer<typeof mockScriptSchema> & { default_plan?: unknown };
