import { z } from 'zod';
import { argv, commandSpec, depth, glob, hex40, nonEmpty, risk } from './common.ts';

const verifyEntry = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    command: argv,
    timeout_s: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal('semantic'), question: nonEmpty }),
]);

const acceptanceCriterion = z
  .strictObject({
    id: z.string().regex(/^AC-[A-Za-z0-9-]+$/),
    text: nonEmpty,
    human_reserved: z.boolean().default(false),
    verify: z.array(verifyEntry).default([]),
  })
  .refine((c) => c.human_reserved || c.verify.length > 0, {
    message: 'a criterion needs at least one verify entry unless human_reserved',
  });

export const publishBlock = z.strictObject({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  remote_url: nonEmpty,
  base_branch: nonEmpty,
  base_commit: hex40,
  visibility_expected: z.enum(['public', 'private']),
  allowed_paths: z.array(glob).min(1),
});
export type PublishBlock = z.infer<typeof publishBlock>;

export const specSchema = z.strictObject({
  schema: z.literal('spec.v1'),
  spec_id: z.string().regex(/^[A-Z0-9-]+$/),
  title: nonEmpty,
  goal: nonEmpty,
  target: z.strictObject({ repo_path: nonEmpty, base_commit: hex40, repo_identity: hex40 }),
  requested_depth: depth,
  declared_risk: risk,
  data_classes: z.array(z.enum(['payment', 'personal', 'irreversible'])),
  product_behaviour: z.string(),
  non_goals: z.array(z.string()),
  architecture_decisions: z.array(z.string()),
  affected_surfaces: z.array(glob),
  invariants: z.array(z.string()),
  acceptance_criteria: z.array(acceptanceCriterion).min(1),
  required_tests: z.array(
    z.strictObject({ id: nonEmpty, command: argv, timeout_s: z.number().int().positive() }),
  ),
  full_test_command: commandSpec,
  expect_red_baseline: z.boolean().default(false),
  gate_commands: z
    .strictObject({
      lint: commandSpec.optional(),
      typecheck: commandSpec.optional(),
      build: commandSpec.optional(),
    })
    .default({}),
  known_control_files: z.array(z.string()).default([]),
  allowed_control_paths: z.array(glob).default([]),
  human_decision_boundaries: z.array(z.string()),
  publish: publishBlock.optional(),
  rollback_expectation: z.string(),
});
export type Spec = z.infer<typeof specSchema>;
export type AcceptanceCriterion = Spec['acceptance_criteria'][number];
