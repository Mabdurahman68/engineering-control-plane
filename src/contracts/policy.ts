import { z } from 'zod';
import { failureClass, nonEmpty } from './common.ts';
import { LANES } from './task.ts';

export const rung = z.strictObject({
  adapter: nonEmpty,
  model: nonEmpty,
  effort: z.string().optional(),
  variant: z.string().optional(),
  auth_mode: z.enum(['subscription', 'api_key']).default('subscription'),
  credential_env: z.array(z.string()).default([]),
});
export type Rung = z.infer<typeof rung>;

export const LADDERS = [
  'planning',
  ...LANES,
  'review',
  'adversarial',
  'adjudication',
  'shadow',
] as const;
export type LadderName = (typeof LADDERS)[number];

export const workersSchema = z.strictObject({
  schema: z.literal('workers.v1'),
  rungs: z.record(z.string(), rung),
  ladders: z.strictObject({
    planning: z.array(z.string()),
    research: z.array(z.string()),
    implementation: z.array(z.string()),
    'hard-code': z.array(z.string()),
    tests: z.array(z.string()),
    'integration-repair': z.array(z.string()),
    review: z.array(z.string()),
    adversarial: z.array(z.string()),
    adjudication: z.array(z.string()),
    shadow: z.array(z.string()),
  }),
});
export type Workers = z.infer<typeof workersSchema>;

export const familiesSchema = z.strictObject({
  schema: z.literal('families.v1'),
  models: z.record(z.string(), z.string()),
});
export type Families = z.infer<typeof familiesSchema>;

export const failureClassesSchema = z.strictObject({
  schema: z.literal('failure_classes.v1'),
  adapters: z.record(
    z.string(),
    z.array(
      z.strictObject({
        class: failureClass,
        exit_code: z.number().int().optional(),
        pattern: z.string().optional(),
        source: z.enum(['documented', 'inferred', 'observed']),
      }),
    ),
  ),
});
export type FailureClasses = z.infer<typeof failureClassesSchema>;

export const cliVersionsSchema = z.strictObject({
  schema: z.literal('cli_versions.v1'),
  adapters: z.record(
    z.string(),
    z.strictObject({
      min: z.string(),
      max: z.string(),
      required_flags: z.array(z.string()),
      help_args: z.array(z.string()),
    }),
  ),
});
export type CliVersions = z.infer<typeof cliVersionsSchema>;

export const secretPatternsSchema = z.strictObject({
  schema: z.literal('secret_patterns.v1'),
  patterns: z.array(z.strictObject({ id: nonEmpty, regex: nonEmpty })).min(1),
});
export type SecretPatterns = z.infer<typeof secretPatternsSchema>;

export const settingsSchema = z.strictObject({
  schema: z.literal('settings.v1'),
  caps: z.strictObject({
    run: z.strictObject({
      invocations: z.number().int().positive(),
      wall_clock_s: z.number().positive(),
      usd: z.number().positive(),
      shadow_invocations: z.number().int().positive(),
      tokens: z.number().positive().nullable(),
    }),
    day: z.strictObject({
      invocations: z.number().int().positive(),
      wall_clock_s: z.number().positive(),
      usd: z.number().positive(),
      shadow_invocations: z.number().int().positive(),
      tokens: z.number().positive().nullable(),
    }),
  }),
  notify: z.strictObject({ command: z.array(z.string()).nullable() }),
  allow_untested_cli: z.boolean(),
  timeouts: z.strictObject({
    probe_s: z.number().positive(),
    shadow_s: z.number().positive(),
    shadow_end_wait_s: z.number().positive(),
    drain_s: z.number().positive(),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const publishForbiddenSchema = z.strictObject({
  schema: z.literal('publish_forbidden.v1'),
  names: z.array(z.string()),
  dirs: z.array(z.string()),
  hashes: z.array(z.string()),
  markers: z.array(z.string()),
});
export type PublishForbidden = z.infer<typeof publishForbiddenSchema>;

export type PolicyBundle = {
  workers: Workers;
  families: Families;
  profiles: import('./profile.ts').Profiles;
  riskRules: import('./profile.ts').RiskRules;
  failureClasses: FailureClasses;
  cliVersions: CliVersions;
  secretPatterns: SecretPatterns;
  settings: Settings;
};
