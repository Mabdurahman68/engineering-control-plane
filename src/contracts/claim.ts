import { z } from 'zod';
import { artifactRef } from './common.ts';

export const VERIFIER_KINDS = [
  'git_diff_stat',
  'file_exists',
  'file_count',
  'line_count',
  'json_path',
  'test_id',
  'none',
] as const;
export const verifier = z.strictObject({
  kind: z.enum(VERIFIER_KINDS),
  spec: z.record(z.string(), z.unknown()),
});
export const CLAIM_TYPES = [
  'FACT',
  'COUNT',
  'TEST_RESULT',
  'FILE_EXISTS',
  'BEHAVIOUR',
  'ARCHITECTURE',
] as const;
export const claimType = z.enum(CLAIM_TYPES);

export const claimSchema = z.strictObject({
  schema: z.literal('claim.v1'),
  claim_id: z.string().regex(/^C-[A-Za-z0-9-]+$/),
  task_id: z.string().nullable(),
  claim: z.string(),
  type: claimType,
  value: z.unknown().nullable(),
  asserted_by: z.string(),
  required: z.boolean(),
  verifier,
  mechanical: z.strictObject({
    status: z.enum(['VERIFIED', 'CONTRADICTED', 'NOT_APPLICABLE']),
    observed: z.unknown(),
    evidence: artifactRef.nullable(),
  }),
  independent_review: z.strictObject({
    status: z.enum(['PASS', 'FAIL', 'NOT_REVIEWED']),
    reviewer: z.string().nullable(),
    reason: z.string().nullable(),
    corrected_value: z.unknown().nullable(),
  }),
  final: z.enum(['VERIFIED', 'CORRECTED', 'REJECTED', 'UNVERIFIED']),
});
export type Claim = z.infer<typeof claimSchema>;
export type Verifier = z.infer<typeof verifier>;
