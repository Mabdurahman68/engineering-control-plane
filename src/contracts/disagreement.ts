import { z } from 'zod';
import { hex40 } from './common.ts';

export const DISAGREEMENT_KINDS = [
  'GATE_FAIL_AGENT_CHALLENGE',
  'MECHANICAL_PASS_SEMANTIC_FAIL',
  'REVIEWER_REVIEWER',
  'CLAIM_CONTRADICTION',
] as const;

// Hard gates can't be waived, whatever the record says. Soft gates carry the S- prefix.
const SOFT_GATE = /^S-/;

export const disagreementSchema = z
  .strictObject({
    schema: z.literal('disagreement.v1'),
    id: z.string().regex(/^D-\d+$/),
    kind: z.enum(DISAGREEMENT_KINDS),
    subject: z.strictObject({
      task_id: z.string().nullable(),
      gate_id: z.string().nullable(),
      review_id: z.string().nullable(),
    }),
    code_result: z.enum(['PASS', 'FAIL']),
    agent_position: z.string(),
    filed_by: z.string(),
    reason: z.string(),
    evidence: z.array(z.string()),
    requested_action: z.enum(['WAIVE', 'OVERRIDE_FINDING', 'REPAIR']),
    adjudication: z.strictObject({
      status: z.enum([
        'PENDING',
        'WAIVED_WITH_EVIDENCE',
        'REJECTED',
        'SPLIT',
        'ESCALATED',
        'ROUTED_TO_REPAIR',
      ]),
      adjudicator: z.string().nullable(),
      reason: z.string().nullable(),
      evidence: z.array(z.string()),
      decided_at: z.string().nullable(),
    }),
  })
  .refine(
    (d) =>
      !(
        d.requested_action === 'WAIVE' &&
        d.subject.gate_id !== null &&
        !SOFT_GATE.test(d.subject.gate_id)
      ),
    { message: 'a hard gate cannot be the subject of requested_action WAIVE' },
  );
export type Disagreement = z.infer<typeof disagreementSchema>;

export const waiverSchema = z.strictObject({
  schema: z.literal('waiver.v1'),
  id: z.string().regex(/^W-\d+$/),
  kind: z.enum(['gate', 'finding']),
  gate_id: z.string().nullable(),
  finding_fingerprint: z.string().nullable(),
  signature: z.string().nullable(),
  disagreement_id: z.string().nullable(),
  scope: z.string(),
  resolves: z.strictObject({
    gate_id: z.string().nullable(),
    signature_element: z.string().nullable(),
    finding_fingerprint: z.string().nullable(),
    criterion: z.string().nullable(),
    semantic_check: z.string().nullable(),
  }),
  review_id: z.string().nullable(),
  tree_at_ruling: hex40,
});
export type Waiver = z.infer<typeof waiverSchema>;
