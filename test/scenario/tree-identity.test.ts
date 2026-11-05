import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../support/assert.ts';
import { makeReal, makeSim, ofType, runReal, runSim } from '../support/harness.ts';

const RULE = 'R-C3-TREE-ID';
const node = process.execPath;
// A test command that rewrites a tracked file when the marker is present.
const rewriter = `const fs=require('fs');if(fs.existsSync('rewrite.marker')){fs.writeFileSync(fs.readFileSync('rewrite.marker','utf8').trim(),'rewritten\\n')}`;

describe('tested = reviewed = committed', () => {
  const plan: any = {
    tasks: [
      {
        task_id: 'T1',
        goal: 'g',
        lane: 'implementation',
        allowed_paths: ['**'],
        forbidden_paths: [],
        acceptance_criteria: ['AC-1'],
        required_tests: ['unit'],
        depends_on: [],
      },
      {
        task_id: 'T2',
        goal: 'g',
        lane: 'implementation',
        allowed_paths: ['other/**'],
        forbidden_paths: [],
        acceptance_criteria: [],
        required_tests: [],
        depends_on: ['T1'],
      },
    ],
    proposed_risk: 'low',
    spec_defects: [],
  };
  it('a gate that rewrites a tracked file discards its evidence and fails H-TREE-ID, on real git', async () => {
    const sim = makeReal({
      plan,
      files: { 'README.md': 'x\n', 'src/a.ts': 'a\n' },
      spec: { required_tests: [{ id: 'unit', command: [node, '-e', rewriter], timeout_s: 30 }] },
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'gate_rewrites_tracked',
          edits: [
            { path: 'src/b.ts', content: 'b\n' },
            { path: 'rewrite.marker', content: 'src/a.ts\n' },
          ],
          times: 1,
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: 'rewrite.marker', content: null }],
        },
      ],
    });
    const exit = await runReal(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const t1 = sim.engine.s.tasks.T1;
    // The first gate run saw a rewritten tree. If no gate in it failed, the rewrite went unnoticed.
    assertNotForbidden(
      RULE,
      !t1.gate_runs[0].results.some((x) => x.status === 'FAIL'),
      'a tree rewritten by a gate passed',
    );
    const first = t1.gate_runs.find((r) =>
      r.results.some((x) => x.id === 'H-TREE-ID' && x.status === 'FAIL'),
    );
    expect(first?.results.find((r) => r.id === 'H-TREE-ID')?.detail).toContain('src/a.ts');
    // No review ran on the tree whose evidence was discarded.
    expect(t1.reviews.every((r) => r.tree !== first?.tree)).toBe(true);
    // What landed is the tree that was gated and reviewed, without the rewrite.
    const commit = t1.commit as string;
    expect(await sim.git.readFile(commit, 'src/a.ts')).toBe('a\n');
    const final = t1.snapshots[t1.snapshots.length - 1];
    expect(await sim.git.treeOf(commit)).toBe(final.tree);
    expect(t1.reviews.at(-1)?.tree).toBe(final.tree);
  });
  it('evidence with an old tree hash does not count', async () => {
    const sim = makeSim();
    const orig = sim.store.read.bind(sim.store);
    void orig;
    await runSim(sim);
    const t1 = sim.engine.s.tasks.T1;
    const last = t1.gate_runs[t1.gate_runs.length - 1];
    for (const r of last.results as any[]) expect(r.tree_hash).toBe(last.tree);
  });
  it('a commit tree that differs from the snapshot fails the run', async () => {
    const sim = makeSim();
    const treeOf = sim.git.treeOf.bind(sim.git);
    sim.git.commitTree = ((orig) => async (tree: string, parents: string[], msg: string) => {
      const commit = await orig(tree, parents, msg);
      if (msg.startsWith('T1:'))
        (sim.git.commits.get(commit) as any).tree = await treeOf(sim.git.root);
      return commit;
    })(sim.git.commitTree.bind(sim.git));
    const exit = await runSim(sim);
    assertNotForbidden(
      RULE,
      exit.state !== 'FAILED',
      'a commit with a different tree was accepted',
    );
    expect(ofType(sim, 'invariant.violation')[0].data.message).toContain('H-TREE-ID');
  });
  it('a new T-INT commit makes earlier integrated evidence stale: verification restarts', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 1 }],
    });
    await runSim(sim);
    const verify = ofType(sim, 'gate.finished').filter((e) => e.data.integrated);
    expect(verify.length).toBe(2);
    assertNotForbidden(
      RULE,
      verify[0].data.tree === verify[1].data.tree,
      'stale integrated evidence was reused',
    );
    expect(sim.engine.s.verify.tree).toBe(verify[1].data.tree);
  });
  it('an acceptance command that changes the tree voids the evidence', async () => {
    const sim = makeSim({
      plan,
      spec: {
        acceptance_criteria: [
          {
            id: 'AC-1',
            text: 'a',
            human_reserved: false,
            verify: [{ kind: 'command', command: ['sim', 'accept'], timeout_s: 5 }],
          },
        ],
      },
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'ok',
          edits: [{ path: 'src/a.txt', content: 'a\n' }],
        },
      ],
    });
    const run = sim.runner.run.bind(sim.runner);
    let armed = true;
    sim.runner.run = async (argv, o) => {
      if (argv[1] === 'accept' && armed) {
        armed = false;
        sim.git.writeFile(o.cwd, 'README.md', 'changed\n');
      }
      return run(argv, o);
    };
    await runSim(sim);
    assertNotForbidden(
      RULE,
      ofType(sim, 'evidence.discarded_stale').length === 0,
      'an acceptance command changed the tree unnoticed',
    );
  });
  it('review checks the same snapshot it was given, before and after', async () => {
    const sim = makeSim();
    await runSim(sim);
    const checks = ofType(sim, 'tree.identity_checked').filter((e) => e.data.phase === 'read_only');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((e) => e.data.ok === true)).toBe(true);
  });
});
