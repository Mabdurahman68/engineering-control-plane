import { describe, expect, it } from 'vitest';
import { computeFinding, identityErrors, stallKey } from '../../../src/review/fingerprint.ts';
import { effectiveVerdict } from '../../../src/review/effective.ts';
import { assertNotForbidden } from '../../support/assert.ts';
import { failReport, finding } from '../../support/review-fixtures.ts';

const src = (
  files: Record<string, string> = { 'a.ts': 'one\ntwo\nthree\nfour\n' },
  tree = 't'.repeat(40),
) => ({
  tree,
  readFile: async (p: string) => files[p] ?? null,
  blobId: async (p: string) =>
    files[p] === undefined ? 'absent' : `blob-${files[p].length}-${files[p]}`,
});
const RULE = 'R-C4-FINGERPRINT';

describe('finding identity', () => {
  it('derives the stall key from the finding fields, normalising the subject', () => {
    expect(
      stallKey({
        criterion: 'AC-2',
        file: 'src/queue.ts',
        category: 'logic',
        finding_type: 'wrong_behaviour',
        subject: 'Unbounded  retry backoff',
      }),
    ).toBe('AC-2|src/queue.ts|logic|wrong_behaviour|unbounded retry backoff');
  });
  it('gives two findings in one file, with different subjects, different fingerprints', async () => {
    const a = await computeFinding(finding({ finding_type: 'missing_code', subject: 'x' }), src());
    const b = await computeFinding(finding({ finding_type: 'missing_code', subject: 'y' }), src());
    assertNotForbidden(RULE, a.fingerprint === b.fingerprint, 'two defects share an identity');
  });
  it('overriding one leaves the other blocking', async () => {
    const a = await computeFinding(finding({ finding_type: 'missing_code', subject: 'x' }), src());
    const b = await computeFinding(finding({ finding_type: 'missing_code', subject: 'y' }), src());
    const r = failReport();
    const review: any = { ...r, findings: [a, b] };
    review.criteria[0].finding_refs = [0, 1];
    const waiver = {
      resolves: {
        gate_id: null,
        signature_element: null,
        finding_fingerprint: a.fingerprint,
        criterion: 'AC-1',
        semantic_check: null,
      },
    };
    const eff = effectiveVerdict(review, [waiver], []);
    assertNotForbidden(RULE, eff.verdict === 'PASS', 'a file-level override hid another finding');
  });
  it('rejects a duplicate subject with a different defect in one review', async () => {
    const errors = await identityErrors(
      [finding({ observed: 'a' }), finding({ observed: 'b' })],
      src(),
    );
    assertNotForbidden(RULE, errors.length === 0, 'a duplicate subject passed');
  });
  it('allows an exact repeat', async () => {
    expect(await identityErrors([finding(), finding()], src())).toEqual([]);
  });
  it('rejects placeholder text', async () => {
    for (const k of ['subject', 'observed', 'expected']) {
      const e = await identityErrors([finding({ [k]: 'TBD' })], src());
      expect(e.length, k).toBeGreaterThan(0);
    }
  });
  it('rejects a line outside the file, and a line with no file', async () => {
    expect((await identityErrors([finding({ line: 99 })], src())).length).toBe(1);
    expect((await identityErrors([finding({ line: 1, file: null })], src())).length).toBe(1);
    expect(await identityErrors([finding({ line: 2 })], src())).toEqual([]);
  });
  it('anchors by hunk, blob or tree, and only the matching change voids it', async () => {
    const line = await computeFinding(finding({ line: 1 }), src());
    expect(line.anchor).toMatch(/^hunk:/);
    const farEdit = { 'a.ts': `${'one\ntwo\nthree\nfour\n'}x\nx\nx\nx\nchanged\n` };
    const lineAgain = await computeFinding(finding({ line: 1 }), src(farEdit));
    expect(lineAgain.anchor).toBe(line.anchor);
    const nearEdit = await computeFinding(
      finding({ line: 1 }),
      src({ 'a.ts': 'one\nCHANGED\nthree\nfour\n' }),
    );
    expect(nearEdit.anchor).not.toBe(line.anchor);
    const blob = await computeFinding(finding(), src());
    expect(blob.anchor).toMatch(/^blob:/);
    const absent = await computeFinding(finding({ file: 'none.ts' }), src());
    expect(absent.anchor).toBe('blob:absent');
    const treeA = await computeFinding(
      finding({ file: null, finding_type: 'missing_code' }),
      src(),
    );
    const treeB = await computeFinding(
      finding({ file: null, finding_type: 'missing_code' }),
      src({}, 'u'.repeat(40)),
    );
    expect(treeA.anchor).not.toBe(treeB.anchor);
  });
});
