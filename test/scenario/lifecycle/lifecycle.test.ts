import { describe, expect, it } from 'vitest';
import {
  decision,
  defaultPlan,
  makeSim,
  ofType,
  resumeSim,
  runSim,
} from '../../support/harness.ts';

const one: any = {
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

describe('depth and risk', () => {
  it.each([
    ['QUICK', 'low', one, 'QUICK'],
    ['STANDARD', 'low', undefined, 'STANDARD'],
    ['DEEP', 'low', undefined, 'DEEP'],
    ['EXHAUSTIVE', 'low', undefined, 'EXHAUSTIVE'],
    ['QUICK', 'high', undefined, 'DEEP'],
    ['QUICK', 'critical', undefined, 'EXHAUSTIVE'],
  ])('requested %s with %s risk completes at depth', async (requested, risk, plan, want) => {
    const sim = makeSim({
      plan,
      spec: { requested_depth: requested as any, declared_risk: risk as any },
    });
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.depth).toBe(want);
  });
  it('a data class forces critical; a critical mock run ends MOCK_RUN_COMPLETE, never READY', async () => {
    const sim = makeSim({ spec: { data_classes: ['payment'] } });
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.risk).toBe('critical');
  });
  it('a surface rule raises risk at the start', async () => {
    const sim = makeSim({ spec: { affected_surfaces: ['auth/login.ts'] } });
    await runSim(sim);
    expect(sim.engine.s.risk).toBe('high');
    expect(sim.engine.s.depth).toBe('DEEP');
  });
  it('the planner can raise risk, never lower it', async () => {
    const sim = makeSim({ plan: { ...defaultPlan(), proposed_risk: 'high' } as any });
    await runSim(sim);
    expect(sim.engine.s.risk).toBe('high');
    const low = makeSim({
      spec: { declared_risk: 'high' },
      plan: { ...defaultPlan(), proposed_risk: 'low' } as any,
    });
    await runSim(low);
    expect(low.engine.s.risk).toBe('high');
  });
  it('risk raised mid-run by a diff, with no size discount: one auth file is high', async () => {
    const plan: any = {
      tasks: [
        {
          task_id: 'T1',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['auth/**'],
          forbidden_paths: [],
          acceptance_criteria: ['AC-1'],
          required_tests: [],
          depends_on: [],
        },
        {
          task_id: 'T2',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['src/**'],
          forbidden_paths: [],
          acceptance_criteria: [],
          required_tests: [],
          depends_on: [],
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
          behaviour: 'ok',
          edits: [{ path: 'auth/x.ts', content: '1\n' }],
        },
      ],
    });
    await runSim(sim);
    expect(ofType(sim, 'risk.raised').some((e) => e.data.risk === 'high')).toBe(true);
    expect(sim.engine.s.depth).toBe('DEEP');
    expect(sim.adapter.log.filter((x) => x.step === 'adversarial').length).toBe(1);
  });
  it('risk raised after TASK_PASSED reopens that task for the stricter review', async () => {
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
        {
          task_id: 'T2',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['auth/**'],
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
      spec: { declared_risk: 'high', requested_depth: 'DEEP' },
      script: [
        {
          match: { task: 'T2', step: 'work' },
          behaviour: 'ok',
          edits: [{ path: 'auth/x.ts', content: '1\n' }],
        },
      ],
      policy: (p) => {
        p.riskRules.rules.push({ when: { path_glob: 'auth/**' }, min_risk: 'critical' });
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const t1 = sim.engine.s.tasks.T1;
    const trigger = ofType(sim, 'task.state_changed').filter(
      (e) => e.task_id === 'T1' && e.data.trigger === 'risk_raised',
    );
    expect(trigger.length).toBe(1);
    // Critical quorum is 2: reopened, it gets a second review before it merges.
    expect(t1.reviews.length).toBe(2);
  });
  it('a reopened task that gets a new commit resets its dependent', async () => {
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
        {
          task_id: 'T2',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['auth/**'],
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
      spec: { declared_risk: 'high', requested_depth: 'DEEP' },
      script: [
        {
          match: { task: 'T2', step: 'work' },
          behaviour: 'ok',
          edits: [{ path: 'auth/x.ts', content: '1\n' }],
        },
        {
          match: { task: 'T1', step: 'review', rung: 'mock-glm' },
          behaviour: 'reviewer_fail',
          times: 1,
        },
      ],
      policy: (p) => {
        p.riskRules.rules.push({ when: { path_glob: 'auth/**' }, min_risk: 'critical' });
      },
    });
    // At critical, the second reviewer's FAIL splits the two, and that goes to the owner.
    expect((await runSim(sim)).state).toBe('ESCALATION_REQUIRED');
    const before = sim.engine.s.tasks.T1.commit;
    const exit = await resumeSim(sim, {
      decision: decision(sim.engine.s.open_escalation as string, 'reject'),
    });
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const reset = ofType(sim, 'task.state_changed').filter(
      (e) => e.task_id === 'T2' && e.data.trigger === 'dependency_reset',
    );
    expect(reset.length).toBeGreaterThan(0);
    const t1 = sim.engine.s.tasks.T1;
    expect(t1.commit).not.toBe(before);
    expect(sim.engine.s.tasks.T2.base_commit).toBe(t1.commit);
  });
});

describe('planning', () => {
  it('valid goes on; invalid re-asks, changes rung, then escalates', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'plan' }, behaviour: 'planner_invalid', args: { kind: 'cycle' } }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(Object.values<any>(sim.engine.s.escalations)[0].reason).toBe('PLAN_INVALID');
    const rungs = sim.adapter.log.filter((x) => x.step === 'plan').map((x) => x.rung);
    expect(rungs.length).toBe(3);
    expect(new Set(rungs).size).toBe(2);
    expect(rungs[0]).toBe(rungs[1]);
  });
  it.each(['cycle', 'uncovered', 'overlap'])('rejects a plan with %s', async (kind) => {
    const sim = makeSim({
      script: [{ match: { step: 'plan' }, behaviour: 'planner_invalid', args: { kind }, times: 1 }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(ofType(sim, 'plan.rejected').length).toBe(1);
  });
  it('a spec defect escalates, with abandon as the only option', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'plan' }, behaviour: 'planner_spec_defect' }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    const rec = Object.values<any>(sim.engine.s.escalations)[0];
    expect(rec.reason).toBe('SPEC_DEFECT');
    expect(rec.options.map((o: any) => o.id)).toEqual(['abandon']);
    const end = await resumeSim(sim, { decision: decision(rec.id, 'abandon') });
    expect(end.state).toBe('CANCELLED');
  });
  it('a malformed plan is re-asked, then goes to the next rung', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'plan', rung: 'mock-anthropic' }, behaviour: 'malformed_report' }],
    });
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    const rungs = sim.adapter.log.filter((x) => x.step === 'plan').map((x) => x.rung);
    expect(rungs).toEqual(['mock-anthropic', 'mock-anthropic', 'mock-openai']);
  });
  it('plan review fails once: re-plans with the findings. Twice: PLAN_INVALID', async () => {
    const once = makeSim({
      spec: { requested_depth: 'DEEP' },
      script: [{ match: { step: 'plan_review' }, behaviour: 'reviewer_fail', times: 1 }],
    });
    expect((await runSim(once)).state).toBe('MOCK_RUN_COMPLETE');
    expect(once.adapter.log.filter((x) => x.step === 'plan').length).toBe(2);
    const twice = makeSim({
      spec: { requested_depth: 'DEEP' },
      script: [{ match: { step: 'plan_review' }, behaviour: 'reviewer_fail' }],
    });
    expect((await runSim(twice)).state).toBe('ESCALATION_REQUIRED');
    expect(Object.values<any>(twice.engine.s.escalations)[0].reason).toBe('PLAN_INVALID');
  });
  it('QUICK allows one task, others need two', async () => {
    const quick = makeSim({ plan: one, spec: { requested_depth: 'QUICK' } });
    expect((await runSim(quick)).state).toBe('MOCK_RUN_COMPLETE');
    const standard = makeSim({ plan: one });
    expect((await runSim(standard)).state).toBe('ESCALATION_REQUIRED');
  });
});

describe('dependencies', () => {
  const chain: any = {
    tasks: [
      {
        task_id: 'T1',
        goal: 'g',
        lane: 'implementation',
        allowed_paths: ['a/**'],
        forbidden_paths: [],
        acceptance_criteria: ['AC-1'],
        required_tests: [],
        depends_on: [],
      },
      {
        task_id: 'T2',
        goal: 'g',
        lane: 'implementation',
        allowed_paths: ['b/**'],
        forbidden_paths: [],
        acceptance_criteria: [],
        required_tests: [],
        depends_on: [],
      },
      {
        task_id: 'T3',
        goal: 'g',
        lane: 'implementation',
        allowed_paths: ['c/**'],
        forbidden_paths: [],
        acceptance_criteria: [],
        required_tests: [],
        depends_on: ['T1', 'T2'],
      },
    ],
    proposed_risk: 'low',
    spec_defects: [],
  };
  it('a dependency escalates, its dependent is blocked, and owner retry unblocks it', async () => {
    const sim = makeSim({
      plan: chain,
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret', times: 1 }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(sim.engine.s.tasks.T3.state).toBe('TASK_BLOCKED');
    const id = sim.engine.s.open_escalation as string;
    const end = await resumeSim(sim, { decision: decision(id, 'retry_task') });
    expect(end.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.tasks.T3.state).toBe('TASK_PASSED');
    const reset = sim.store.read(
      `attempts/${
        Object.values(sim.engine.s.attempts)
          .filter((a) => a.task_id === 'T1')
          .at(-2)?.attempt_id
      }/brief.txt`,
    );
    expect(typeof reset).toBe('string');
  });
  it('a ready task holds while another is escalated', async () => {
    const plan: any = {
      tasks: [
        {
          task_id: 'T1',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['a/**'],
          forbidden_paths: [],
          acceptance_criteria: ['AC-1'],
          required_tests: [],
          depends_on: [],
        },
        {
          task_id: 'T2',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['b/**'],
          forbidden_paths: [],
          acceptance_criteria: [],
          required_tests: [],
          depends_on: [],
        },
        {
          task_id: 'T3',
          goal: 'g',
          lane: 'implementation',
          allowed_paths: ['c/**'],
          forbidden_paths: [],
          acceptance_criteria: [],
          required_tests: [],
          depends_on: ['T2'],
        },
      ],
      proposed_risk: 'low',
      spec_defects: [],
    };
    const sim = makeSim({
      plan,
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'write_secret' },
        { match: { task: 'T2', step: 'work' }, behaviour: 'ok', delay_ms: 5000 },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(sim.engine.s.tasks.T2.state).toBe('TASK_PASSED');
    expect(sim.engine.s.tasks.T3.state).toBe('READY');
    expect(sim.engine.s.tasks.T3.attempts).toBe(0);
  });
  it('several dependencies: a clean synthetic base holds both', async () => {
    const sim = makeSim({ plan: chain });
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    const t3 = sim.engine.s.tasks.T3;
    const parents = sim.git.commits.get(t3.base_commit as string)?.parents;
    expect(parents?.length).toBe(2);
  });
  it('several dependencies: a conflicting synthetic base escalates, offering only abandon', async () => {
    const sim = makeSim({
      plan: chain,
      prep: (s: any) => {
        const merge = s.git.mergeTrees.bind(s.git);
        s.git.mergeTrees = (a: string, b: string) => {
          if (s.engine.s.state === 'EXECUTING') s.git.conflictOn = 'a/x.txt';
          return merge(a, b);
        };
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    const rec = Object.values<any>(sim.engine.s.escalations)[0];
    expect(rec.reason).toBe('MERGE_CONFLICT');
    expect(rec.options.map((o: any) => o.id)).toEqual(['abandon']);
  });
});

describe('owner decisions, one row each', () => {
  const secret: any[] = [
    { match: { task: 'T1', step: 'work' }, behaviour: 'write_secret', times: 1 },
  ];
  it('HARD_GATE_BREACH retry_task resets the task to base, with the note in its brief', async () => {
    const sim = makeSim({ script: secret });
    await runSim(sim);
    const end = await resumeSim(sim, {
      decision: decision(sim.engine.s.open_escalation as string, 'retry_task'),
    });
    expect(end.state).toBe('MOCK_RUN_COMPLETE');
    const t1 = sim.engine.s.tasks.T1;
    expect(t1.snapshots.length).toBe(1);
    const a = Object.values(sim.engine.s.attempts)
      .filter((x) => x.task_id === 'T1' && x.step === 'work')
      .at(-1) as any;
    expect(sim.store.read(`attempts/${a.attempt_id}/brief.txt`)).toContain('owner note');
    // The secret is gone from what landed.
    expect(await sim.git.diffText(sim.git.root, t1.commit as string)).not.toContain('AKIA');
  });
  it('HARD_GATE_BREACH abandon cancels', async () => {
    const sim = makeSim({ script: secret });
    await runSim(sim);
    const end = await resumeSim(sim, {
      decision: decision(sim.engine.s.open_escalation as string, 'abandon'),
    });
    expect(end.state).toBe('CANCELLED');
  });
  it('REPAIR_EXHAUSTED retry_task resets the counter, so a decision cannot re-exhaust at once', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 3 },
        { match: { task: 'T1', step: 'repair' }, behaviour: 'no_change', times: 2 },
      ],
    });
    expect((await runSim(sim)).state).toBe('ESCALATION_REQUIRED');
    const end = await resumeSim(sim, {
      decision: decision(sim.engine.s.open_escalation as string, 'retry_task'),
    });
    expect(end.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.tasks.T1.repairs).toBe(0);
  });
  it('REPAIR_EXHAUSTED at integration: retry_integration resets the integrated counter', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 3 }],
    });
    expect((await runSim(sim)).state).toBe('ESCALATION_REQUIRED');
    const end = await resumeSim(sim, {
      decision: decision(sim.engine.s.open_escalation as string, 'retry_integration'),
    });
    expect(end.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.integrated_repairs).toBeLessThanOrEqual(1);
  });
  it('UNVERIFIABLE_CRITERION: mark_human_verified restarts verification, and does not re-escalate', async () => {
    const sim = makeSim({
      script: [
        {
          match: { step: 'acceptance' },
          behaviour: 'reviewer_fail',
          args: { unverifiable: true },
          times: 1,
        },
        {
          match: { step: 'acceptance' },
          behaviour: 'reviewer_fail',
          args: { unverifiable_pass: true },
        },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    const rec = Object.values<any>(sim.engine.s.escalations)[0];
    expect(rec.reason).toBe('UNVERIFIABLE_CRITERION');
    const end = await resumeSim(sim, { decision: decision(rec.id, 'mark_human_verified', 'AC-1') });
    expect(end.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.human_verified).toEqual(['AC-1']);
    expect(Object.values(sim.engine.s.escalations).length).toBe(1);
  });
  it('a stale decision for another escalation is refused', async () => {
    const sim = makeSim({ script: secret });
    await runSim(sim);
    await expect(resumeSim(sim, { decision: decision('E-99', 'abandon') })).rejects.toThrow(
      /open is/,
    );
  });
});
