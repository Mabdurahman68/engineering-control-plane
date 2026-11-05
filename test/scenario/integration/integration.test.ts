import { describe, expect, it } from 'vitest';
import {
  decision,
  makeReal,
  makeSim,
  ofType,
  resumeSim,
  runReal,
  runSim,
} from '../../support/harness.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const conflictSecondMerge = (sim: any) => {
  const merge = sim.git.mergeTrees.bind(sim.git);
  sim.git.mergeTrees = (a: string, b: string) => {
    if (sim.engine.s.tasks.T2?.commit === b && !sim.engine.s.integration.merged.includes('T2'))
      sim.git.conflictOn = 'src/t2/c.txt';
    return merge(a, b);
  };
};
const resolved = { path: 'src/t2/c.txt', content: 'resolved\n' };

describe('integration', () => {
  it('clean merge and passing gates: a 3-task run ends in MOCK_RUN_COMPLETE, on real git', async () => {
    const sim = makeReal();
    const exit = await runReal(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const tip = sim.engine.s.integration.tip as string;
    expect(g(sim.repo, 'rev-parse', 'ecp/run1/integration')).toBe(tip);
  });
  it('a clean merge is not evidence: integrated gates still run, and their failure opens T-INT', async () => {
    const edits = [{ path: 'src/t2/x.txt', content: 'x\n' }];
    const sim = makeSim({
      plan: {
        tasks: [
          {
            task_id: 'T1',
            goal: 'g',
            lane: 'implementation',
            allowed_paths: ['**'],
            forbidden_paths: [],
            acceptance_criteria: ['AC-1'],
            required_tests: [],
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
      } as any,
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'ok',
          edits: [
            ...edits,
            { path: '.sim/fail/full', content: 'Error: only the full suite sees this\n' },
          ],
        },
        { match: { task: 'T-INT-1', step: 'challenge' }, behaviour: 'challenge_none' },
        {
          match: { task: 'T-INT-1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: '.sim/fail/full', content: null }],
        },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.tasks['T-INT-1'].state).toBe('TASK_PASSED');
    expect(ofType(sim, 'gate.finished').filter((e) => e.data.integrated).length).toBe(2);
  });
  it('a clean merge with a semantic failure: acceptance FAIL opens T-INT, then verification restarts', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 1 }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const t = sim.engine.s.tasks['T-INT-1'];
    expect(t.state).toBe('TASK_PASSED');
    expect(t.repairs).toBe(1);
    // The T-INT task is itself reviewed by a family outside the integrated authors.
    expect(t.reviews[0].family).not.toBe('openai');
    expect(sim.engine.s.verify.generation).toBe(2);
    expect(ofType(sim, 'gate.finished').filter((e) => e.data.integrated).length).toBe(2);
  });
  it('the integrated repair limit escalates', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail' }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(Object.values<any>(sim.engine.s.escalations).at(-1).reason).toBe('REPAIR_EXHAUSTED');
    expect(sim.engine.s.integrated_repairs).toBe(
      sim.policy.profiles.profiles.STANDARD.integrated_repair_max,
    );
  });
  it('a conflict is resolved once by T-INT, and its commit has both parents', async () => {
    const sim = makeSim({
      prep: conflictSecondMerge,
      script: [
        { match: { task: 'T-INT-1', step: 'work' }, behaviour: 'resolver_ok', edits: [resolved] },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const t = sim.engine.s.tasks['T-INT-1'];
    expect(t.conflict_of).toBe('T2');
    const commit = sim.git.commits.get(t.commit as string);
    expect(commit?.parents.length).toBe(2);
    expect(commit?.parents).toContain(sim.engine.s.tasks.T2.commit);
    expect(sim.engine.s.integration.merged).toContain('T2');
    // The markers were snapshot 0, with no author.
    expect(t.snapshots[0].family).toBeNull();
    expect(await sim.git.readFile(t.snapshots[0].commit, 'src/t2/c.txt')).toContain('<<<<<<<');
    expect(await sim.git.readFile(t.commit as string, 'src/t2/c.txt')).toBe('resolved\n');
  });
  it('H-NOMARKERS: a resolver that leaves markers fails, and repairs', async () => {
    const sim = makeSim({
      prep: conflictSecondMerge,
      script: [
        { match: { task: 'T-INT-1', step: 'work' }, behaviour: 'resolver_fail' },
        { match: { task: 'T-INT-1', step: 'repair' }, behaviour: 'resolver_ok', edits: [resolved] },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const run = sim.engine.s.tasks['T-INT-1'].gate_runs[0];
    expect(run.results.find((r) => r.id === 'H-NOMARKERS')?.status).toBe('FAIL');
  });
  it('a second conflict escalates as MERGE_CONFLICT', async () => {
    const sim = makeSim({
      prep: (s: any) => {
        const merge = s.git.mergeTrees.bind(s.git);
        s.git.mergeTrees = (a: string, b: string) => {
          if ([s.engine.s.tasks.T2?.commit, s.engine.s.tasks.T3?.commit].includes(b))
            s.git.conflictOn = 'src/t2/c.txt';
          return merge(a, b);
        };
      },
      script: [
        { match: { task: 'T-INT-1', step: 'work' }, behaviour: 'resolver_ok', edits: [resolved] },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(Object.values<any>(sim.engine.s.escalations).at(-1).reason).toBe('MERGE_CONFLICT');
  });
  it('QUICK escalates a conflict straight away, with no attempt', async () => {
    const plan: any = {
      tasks: [
        {
          task_id: 'T1',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['src/t1/**'],
          forbidden_paths: [],
          acceptance_criteria: ['AC-1'],
          required_tests: [],
          depends_on: [],
        },
        {
          task_id: 'T2',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['src/t2/**'],
          forbidden_paths: [],
          acceptance_criteria: [],
          required_tests: [],
          depends_on: [],
        },
      ],
      proposed_risk: 'low',
      spec_defects: [],
    };
    const sim = makeSim({ plan, prep: conflictSecondMerge, spec: { requested_depth: 'QUICK' } });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(sim.engine.s.tasks['T-INT-1']).toBeUndefined();
    const rec = Object.values<any>(sim.engine.s.escalations).at(-1);
    expect(rec.options.map((o: any) => o.id)).toEqual(['retry_integration', 'abandon']);
  });
  it('owner retry_integration opens a new T-INT, with the note in its brief', async () => {
    const sim = makeSim({
      prep: conflictSecondMerge,
      spec: { requested_depth: 'QUICK' },
      plan: {
        tasks: [
          {
            task_id: 'T1',
            goal: 'g',
            lane: 'implementation',
            allowed_paths: ['src/t1/**'],
            forbidden_paths: [],
            acceptance_criteria: ['AC-1'],
            required_tests: [],
            depends_on: [],
          },
          {
            task_id: 'T2',
            goal: 'g',
            lane: 'implementation',
            allowed_paths: ['src/t2/**'],
            forbidden_paths: [],
            acceptance_criteria: [],
            required_tests: [],
            depends_on: [],
          },
        ],
        proposed_risk: 'low',
        spec_defects: [],
      } as any,
      script: [
        { match: { task: 'T-INT-1', step: 'work' }, behaviour: 'resolver_ok', edits: [resolved] },
      ],
    });
    await runSim(sim);
    const id = sim.engine.s.open_escalation as string;
    const exit = await resumeSim(sim, { decision: decision(id, 'retry_integration') });
    expect(['MOCK_RUN_COMPLETE', 'ESCALATION_REQUIRED']).toContain(exit.state);
    const a = Object.values(sim.engine.s.attempts).find((x) => x.task_id === 'T-INT-1') as any;
    expect(sim.store.read(`attempts/${a.attempt_id}/brief.txt`)).toContain('owner note');
  });
  it('a real conflict on real git keeps its markers in snapshot 0', async () => {
    const sim = makeReal({
      script: [
        {
          match: { task: 'T-INT-1', step: 'work' },
          behaviour: 'resolver_ok',
          edits: [{ path: 'src/t2/c.txt', content: 'resolved\n' }],
        },
      ],
    });
    // Commit the two sides by hand; plan validation keeps ordinary runs from ever reaching this.
    const orig = sim.git.mergeTrees.bind(sim.git);
    let armed = true;
    sim.git.mergeTrees = async (a, b) => {
      if (!armed || sim.engine.s.tasks.T2?.commit !== b) return orig(a, b);
      armed = false;
      const wt = join(sim.repo, '..', `wt-${Date.now()}`);
      await sim.git.addWorktree(wt, null, b);
      writeFileSync(join(wt, 'README.md'), 'theirs\n');
      const theirs = await sim.git.snapshot(wt, 'refs/x/theirs', b, 'theirs');
      await sim.git.resetWorktree(wt, a);
      writeFileSync(join(wt, 'README.md'), 'ours\n');
      const ours = await sim.git.snapshot(wt, 'refs/x/ours', a, 'ours');
      await sim.git.removeWorktree(wt);
      return orig(ours.commit, theirs.commit);
    };
    const exit = await runReal(sim);
    const t = sim.engine.s.tasks['T-INT-1'];
    expect(t.conflict_of).toBe('T2');
    expect(await sim.git.readFile(t.snapshots[0].commit, 'README.md')).toContain('<<<<<<<');
    expect(t.gate_runs[0].results.find((r) => r.id === 'H-NOMARKERS')?.status).toBe('FAIL');
    expect(exit.state).not.toBe('READY_FOR_HUMAN_MERGE');
  });
});

describe('planted claims in a run', () => {
  it('85 versus 84: the claim blocks at H-CLAIMS, then clears when repair reconciles', async () => {
    const sim = makeSim({
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'claim_false_count',
          args: { value: 85 },
        },
        { match: { task: 'T1', step: 'repair' }, behaviour: 'ok', report: { claims: [] } },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const runs = sim.engine.s.tasks.T1.gate_runs;
    expect(runs[0].results.find((r) => r.id === 'H-CLAIMS')?.status).toBe('FAIL');
    expect(runs[runs.length - 1].results.find((r) => r.id === 'H-CLAIMS')?.status).toBe('PASS');
    // The earlier claim stays on the ledger.
    const claims = ofType(sim, 'claim.recorded').map((e) => e.data.claim as any);
    const planted = claims.find((c) => c.claim.includes('85'));
    expect(planted.mechanical.status).toBe('CONTRADICTED');
    expect(planted.mechanical.observed).toBe(1);
  });
  it('a worker claiming tests passed when they fail is caught by the test evidence', async () => {
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
    const sim = makeSim({
      plan,
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'claim_tests_passed_false',
          args: { tests: ['unit'] },
          edits: [
            { path: 'src/a.txt', content: 'a\n' },
            { path: '.sim/fail/unit', content: 'Error: no\n' },
          ],
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: '.sim/fail/unit', content: null }],
        },
      ],
    });
    await runSim(sim);
    const first = sim.engine.s.tasks.T1.gate_runs[0].results;
    expect(first.find((r) => r.id === 'H-TESTS-PASS')?.status).toBe('FAIL');
    expect(first.find((r) => r.id === 'H-CLAIMS')?.status).toBe('FAIL');
  });
  it('a worker that reports touched files gets its diff from git instead', async () => {
    const sim = makeSim({
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'reports_touched_files',
          edits: [{ path: 'src/t1/real.txt', content: 'x\n' }],
        },
      ],
    });
    await runSim(sim);
    expect(sim.engine.s.tasks.T1.gate_runs[0].changed?.map((f) => f.path)).toEqual([
      'src/t1/real.txt',
    ]);
  });
});

describe('acceptance', () => {
  const unverifiable = (acs: string[], file: string) => ({
    verdict: 'FAIL',
    criteria: acs.map((ac) => ({
      ac,
      verdict: 'UNVERIFIABLE',
      evidence: "can't check",
      finding_refs: [0],
    })),
    semantic_checks: Object.fromEntries(
      ['spec_fidelity', 'architecture', 'security', 'test_adequacy', 'merge_compat'].map((n) => [
        n,
        { verdict: 'PASS', note: '', finding_refs: [] },
      ]),
    ),
    findings: [
      {
        criterion: acs[0],
        category: 'spec',
        finding_type: 'other',
        subject: 'no way to check it',
        observed: 'no signal available',
        expected: 'a signal',
        severity: 'major',
        file,
        line: null,
        message: 'm',
        required_repair: 'r',
      },
    ],
    claims_reviewed: [],
    looked_at: { files: [], commands: [], not_examined: [] },
  });
  void unverifiable;
  it('a human-reserved criterion is shown as such, and needs no reviewer evidence', async () => {
    const sim = makeSim({
      spec: {
        acceptance_criteria: [
          {
            id: 'AC-1',
            text: 'a',
            human_reserved: false,
            verify: [{ kind: 'semantic', question: 'q' }],
          },
          { id: 'AC-2', text: 'looks right', human_reserved: true, verify: [] },
        ],
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
  it('a failing AC command opens repair', async () => {
    const sim = makeSim({
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
      plan: {
        tasks: [
          {
            task_id: 'T1',
            goal: 'g',
            lane: 'implementation',
            allowed_paths: ['**'],
            forbidden_paths: [],
            acceptance_criteria: ['AC-1'],
            required_tests: [],
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
      } as any,
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'ok',
          edits: [
            { path: 'src/a.txt', content: 'a\n' },
            { path: '.sim/fail/accept', content: 'Error: nope\n' },
          ],
        },
        {
          match: { task: 'T-INT-1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: '.sim/fail/accept', content: null }],
        },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.tasks['T-INT-1'].repairs).toBe(1);
    expect(sim.engine.s.verify.ac_evidence['AC-1']).toBe('PASS');
  });
  it('DEEP adds an adversarial stage; critical adds three lenses', async () => {
    const deep = makeSim({ spec: { requested_depth: 'DEEP' } });
    await runSim(deep);
    expect(deep.adapter.log.filter((x) => x.step === 'adversarial').length).toBe(1);
    const crit = makeSim({ spec: { requested_depth: 'EXHAUSTIVE', declared_risk: 'critical' } });
    expect((await runSim(crit)).state).toBe('MOCK_RUN_COMPLETE');
    expect(crit.adapter.log.filter((x) => x.step === 'adversarial').length).toBe(1);
    expect(crit.adapter.log.filter((x) => x.step === 'lens').length).toBe(3);
  });
  it('an adversarial FAIL takes the same path as a failed review', async () => {
    const sim = makeSim({
      spec: { requested_depth: 'DEEP' },
      script: [{ match: { step: 'adversarial' }, behaviour: 'reviewer_fail', times: 1 }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.tasks['T-INT-1'].repairs).toBe(1);
  });
  it('EXHAUSTIVE runs the full suite twice', async () => {
    const sim = makeSim({ spec: { requested_depth: 'EXHAUSTIVE', declared_risk: 'critical' } });
    await runSim(sim);
    const lastVerify = ofType(sim, 'gate.finished')
      .filter((e) => e.data.integrated)
      .at(-1)?.data.results as any[];
    expect(lastVerify.filter((r) => r.id === 'S-REGRESSION').length).toBe(2);
  });
  it('READY is not reachable under mock review, even with every check passing', async () => {
    for (const depth of ['QUICK', 'STANDARD', 'DEEP'] as const) {
      const plan: any = {
        tasks: [
          {
            task_id: 'T1',
            goal: 'g',
            lane: 'implementation',
            allowed_paths: ['src/**'],
            forbidden_paths: [],
            acceptance_criteria: ['AC-1'],
            required_tests: [],
            depends_on: [],
          },
        ],
        proposed_risk: 'low',
        spec_defects: [],
      };
      if (depth !== 'QUICK')
        plan.tasks.push({
          ...plan.tasks[0],
          task_id: 'T2',
          allowed_paths: ['other/**'],
          acceptance_criteria: [],
        });
      const sim = makeSim({ spec: { requested_depth: depth }, plan });
      expect((await runSim(sim)).state, depth).toBe('MOCK_RUN_COMPLETE');
    }
  });
});
