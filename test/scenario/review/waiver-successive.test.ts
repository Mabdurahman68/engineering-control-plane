import { describe, expect, it } from 'vitest';
import { effectiveVerdict } from '../../../src/review/effective.ts';
import { computeFinding } from '../../../src/review/fingerprint.ts';
import { assertNotForbidden } from '../../support/assert.ts';
import { makeSim, ofType, runSim } from '../../support/harness.ts';
import { finding, passReport } from '../../support/review-fixtures.ts';

const RULE = 'B1-WAIVER';
const srcOf = (blob: string, tree = 't'.repeat(40)) => ({
  tree,
  readFile: async () => 'x\n',
  blobId: async () => blob,
});

async function reviewWith(f: any, src: any) {
  const c = await computeFinding(f, src);
  const r: any = passReport();
  r.verdict = 'FAIL';
  r.findings = [c];
  r.criteria[0].verdict = 'FAIL';
  r.criteria[0].finding_refs = [0];
  return { r, c };
}

describe('waiver identity across successive reviews', () => {
  const S = { subject: 'the retry path', observed: 'A', expected: 'E' };
  it('the four-review sequence, file-level finding', async () => {
    const first = await reviewWith(finding(S), srcOf('blob1'));
    const w = {
      resolves: {
        gate_id: null,
        signature_element: null,
        finding_fingerprint: first.c.fingerprint,
        criterion: 'AC-1',
        semantic_check: null,
      },
    };
    // Review 2: same tree, same stall_key, a different observation. It blocks.
    const r2 = await reviewWith(finding({ ...S, observed: 'B' }), srcOf('blob1'));
    expect(r2.c.stall_key).toBe(first.c.stall_key);
    assertNotForbidden(
      RULE,
      effectiveVerdict(r2.r, [w], []).verdict === 'PASS',
      'a different defect passed under an old waiver',
    );
    // Review 3: the same words, but the file changed. It blocks.
    const r3 = await reviewWith(finding(S), srcOf('blob2'));
    assertNotForbidden(
      RULE,
      effectiveVerdict(r3.r, [w], []).verdict === 'PASS',
      'the waiver survived a changed file',
    );
    // Review 4: the same words, the same blob. It doesn't block.
    const r4 = await reviewWith(finding(S), srcOf('blob1'));
    expect(effectiveVerdict(r4.r, [w], []).verdict).toBe('PASS');
  });
  it('the same for a missing-code finding with no file, against a changed tree', async () => {
    const mc = { ...S, file: null, finding_type: 'missing_code' };
    const treeA = srcOf('x', 'a'.repeat(40));
    const treeB = srcOf('x', 'b'.repeat(40));
    const first = await reviewWith(finding(mc), treeA);
    const w = {
      resolves: {
        gate_id: null,
        signature_element: null,
        finding_fingerprint: first.c.fingerprint,
        criterion: 'AC-1',
        semantic_check: null,
      },
    };
    const changed = await reviewWith(finding(mc), treeB);
    assertNotForbidden(
      RULE,
      effectiveVerdict(changed.r, [w], []).verdict === 'PASS',
      'the waiver survived a changed tree',
    );
    const same = await reviewWith(finding(mc), treeA);
    expect(effectiveVerdict(same.r, [w], []).verdict).toBe('PASS');
  });
  it('conservative invalidations block too: paraphrase, unrelated edit in the file, any tree change', async () => {
    const first = await reviewWith(finding(S), srcOf('blob1'));
    const w = {
      resolves: {
        gate_id: null,
        signature_element: null,
        finding_fingerprint: first.c.fingerprint,
        criterion: 'AC-1',
        semantic_check: null,
      },
    };
    const paraphrase = await reviewWith(
      finding({ ...S, observed: 'A, said another way' }),
      srcOf('blob1'),
    );
    const edit = await reviewWith(finding(S), srcOf('blob-with-an-unrelated-edit'));
    for (const r of [paraphrase, edit]) expect(effectiveVerdict(r.r, [w], []).verdict).toBe('FAIL');
  });
});

describe('waiver identity through the engine', () => {
  const edits = [{ path: 'src/t1/a.txt', content: 'a\n' }];
  const same = {
    criterion: 'AC-1',
    file: 'src/t1/a.txt',
    subject: 'the path',
    observed: 'A',
    expected: 'E',
  };
  const base = (rest: any[]) => [
    { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits },
    ...rest,
  ];

  it('a re-raised waived finding gives an effective PASS', async () => {
    const sim = makeSim({
      script: base([
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_fail',
          args: { findings: [same] },
          times: 2,
        },
        { match: { task: 'T1', step: 'repair' }, behaviour: 'dispute_finding', edits, times: 1 },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'override' },
        },
      ]),
    });
    await runSim(sim);
    const r = sim.engine.s.tasks.T1.reviews;
    expect(r.map((x) => [x.verdict, x.effective])).toEqual([
      ['FAIL', 'FAIL'],
      ['FAIL', 'PASS'],
    ]);
  });
  it('the same subject with a different defect blocks, and is reported apart from new findings', async () => {
    const sim = makeSim({
      script: base([
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_fail',
          args: { findings: [same] },
          times: 1,
        },
        { match: { task: 'T1', step: 'repair' }, behaviour: 'dispute_finding', edits, times: 1 },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'override' },
          times: 1,
        },
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_fail',
          args: { findings: [{ ...same, observed: 'B' }] },
          times: 1,
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: 'src/t1/a.txt', content: 'fixed\n' }],
        },
      ]),
    });
    await runSim(sim);
    const reviews = sim.engine.s.tasks.T1.reviews;
    assertNotForbidden(RULE, reviews[1].effective === 'PASS', 'different defect passed in a run');
    const collected = ofType(sim, 'review.collected').filter((e) => e.task_id === 'T1');
    expect((collected[1].data.waiver_void as any[])[0].cause).toBe('text_changed');
  });
  it('a fourth adjudication escalates', async () => {
    const script: any[] = base([]);
    for (let i = 0; i < 5; i++) {
      script.push({
        match: { task: 'T1', step: 'review' },
        behaviour: 'reviewer_fail',
        args: { findings: [{ ...same, subject: `the path, round ${i}`, observed: `round ${i}` }] },
        times: 1,
      });
      script.push({
        match: { task: 'T1', step: 'repair' },
        behaviour: 'dispute_finding',
        edits: [{ path: 'src/t1/a.txt', content: `v${i}\n` }],
        times: 1,
      });
    }
    script.push({
      match: { task: 'T1', step: 'adjudicate' },
      behaviour: 'adjudicate',
      args: { ruling: 'override' },
    });
    const sim = makeSim({
      script,
      spec: { requested_depth: 'DEEP' },
      policy: (p) => {
        p.profiles.profiles.DEEP.repair_max = 20;
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(sim.engine.s.tasks.T1.adjudications).toBe(3);
    expect(sim.engine.s.tasks.T1.escalation_reason).toBe('UNRESOLVED_DISAGREEMENT');
  });
  it('repeated rewording still hits the stall limit', async () => {
    const script: any[] = base([]);
    for (let i = 0; i < 6; i++) {
      script.push({
        match: { task: 'T1', step: 'review' },
        behaviour: 'reviewer_fail',
        args: { findings: [{ ...same, observed: `reworded ${i}` }] },
        times: 1,
      });
      script.push({
        match: { task: 'T1', step: 'repair' },
        behaviour: 'ok',
        edits: [{ path: 'src/t1/a.txt', content: `v${i}\n` }],
        times: 1,
      });
    }
    const sim = makeSim({ script });
    const exit = await runSim(sim);
    assertNotForbidden(
      RULE,
      exit.state === 'MOCK_RUN_COMPLETE',
      'rewording dodged the stall limit',
    );
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(
      ofType(sim, 'stall.detected').filter((e) => e.data.reason === 'same_finding').length,
    ).toBeGreaterThan(0);
    expect(sim.engine.s.tasks.T1.escalation_reason).toBe('REPAIR_EXHAUSTED');
  });
});
