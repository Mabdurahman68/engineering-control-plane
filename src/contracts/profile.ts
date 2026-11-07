import { z } from 'zod';
import { depth, glob, risk } from './common.ts';

const profile = z.strictObject({
  max_tasks: z.number().int().positive(),
  plan_review: z.boolean(),
  parallel_writers: z.number().int().positive(),
  repair_max: z.number().int().nonnegative(),
  integrated_repair_max: z.number().int().nonnegative(),
  worker_timeout_s: z.number().int().positive(),
  task_tests: z.enum(['required', 'required_and_full']),
  integrated_full_runs: z.number().int().positive(),
  review_input: z.enum(['diff', 'spec_excerpt', 'full_spec_repo']),
  adversarial: z.enum(['none', 'one', 'three_lenses']),
  targeted_checks: z.boolean(),
  claim_ledger: z.enum(['required_only', 'all', 'all_and_figures']),
});
export type Profile = z.infer<typeof profile>;

export const profilesSchema = z.strictObject({
  schema: z.literal('risk_depth_profile.v1'),
  profiles: z.strictObject({
    QUICK: profile,
    STANDARD: profile,
    DEEP: profile,
    EXHAUSTIVE: profile,
  }),
  min_depth_for_risk: z.strictObject({ low: depth, medium: depth, high: depth, critical: depth }),
  quorum: z.strictObject({
    low: z.number().int().positive(),
    medium: z.number().int().positive(),
    high: z.number().int().positive(),
    critical: z.number().int().positive(),
  }),
});
export type Profiles = z.infer<typeof profilesSchema>;

export const riskRulesSchema = z.strictObject({
  schema: z.literal('risk_rules.v1'),
  default_risk: risk,
  doc_only_risk: risk,
  doc_globs: z.array(glob),
  rules: z.array(
    z.strictObject({
      when: z.strictObject({
        path_glob: glob.optional(),
        keyword: z.string().optional(),
        data_class: z.string().optional(),
      }),
      min_risk: risk,
    }),
  ),
});
export type RiskRules = z.infer<typeof riskRulesSchema>;
