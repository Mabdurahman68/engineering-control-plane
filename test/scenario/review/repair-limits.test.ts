import { describe, expect, it } from 'vitest';
import { makeSim, ofType, runSim } from '../../support/harness.ts';

const fail = (o: any = {}) => ({
  match: { task: 'T1', step: 'review' },
  behaviour: 'reviewer_fail',
  ...o,
});

describe('repair limits and stall detection', () => {
  it.each([
    ['QUICK', 2],
    ['STANDARD', 3],
    ['DEEP', 4],
    ['EXHAUSTIVE', 4],
  ])('limit by depth: %s allows %i repairs before the rung switch', async (depth, max) => {
    const plan = {
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
    const planPlus =
      depth === 'QUICK'
        ? plan
        : {
            ...plan,
            tasks: [
              ...plan.tasks,
              {
                ...plan.tasks[0],
                task_id: 'T2',
                allowed_paths: ['other/**'],
                acceptance_criteria: [],
              },
            ],
          };
    const risk = depth === 'EXHAUSTIVE' ? 'critical' : 'low';
    let i = 0;
    const edits = () => [{ path: 'src/a.txt', content: `${i++}\n` }];
    const script: any[] = [
      { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits: edits() },
    ];
    for (let k = 0; k < 12; k++) {
      script.push(
        fail({
          args: { findings: [{ subject: `s${k}`, observed: `o${k}`, criterion: 'AC-1' }] },
          times: 1,
        }),
      );
      script.push({
        match: { task: 'T1', step: 'repair' },
        behaviour: 'ok',
        edits: edits(),
        times: 1,
      });
    }
    const sim = makeSim({
      plan: planPlus as any,
      script,
      spec: { requested_depth: depth as any, declared_risk: risk as any },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    const rec = sim.engine.s.tasks.T1;
    expect(rec.escalation_reason).toBe('REPAIR_EXHAUSTED');
    // The limit, then one more on the switched rung.
    expect(rec.repairs).toBe(max + 1);
    expect(rec.repair_rung_switches).toBe(1);
    expect(sim.engine.s.depth).toBe(depth);
  });
  it('same failure stalls', async () => {
    const edits = (n: number) => [
      { path: 'src/t1/a.txt', content: `${n}\n` },
      { path: '.sim/fail/unit', content: 'Error: same\n' },
    ];
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
          allowed_paths: ['x/**'],
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
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits: edits(0) },
        { match: { task: 'T1', step: 'repair', attempt: 2 }, behaviour: 'ok', edits: edits(1) },
        { match: { task: 'T1', step: 'repair', attempt: 3 }, behaviour: 'ok', edits: edits(2) },
        { match: { task: 'T1', step: 'repair' }, behaviour: 'ok', edits: edits(3) },
      ],
    });
    await runSim(sim);
    expect(ofType(sim, 'stall.detected')[0].data.reason).toBe('same_failure');
  });
  it('a repair that changes nothing stalls', async () => {
    const sim = makeSim({
      script: [
        fail({ times: 9 }),
        { match: { task: 'T1', step: 'repair' }, behaviour: 'no_change' },
      ],
    });
    await runSim(sim);
    expect(ofType(sim, 'stall.detected')[0].data.reason).toBe('no_change');
  });
  it('oscillation between two trees stalls', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'oscillate' },
        fail({ args: { findings: [{ subject: 'a' }] }, times: 1 }),
        fail({ args: { findings: [{ subject: 'b' }] }, times: 1 }),
        fail({ args: { findings: [{ subject: 'c' }] }, times: 9 }),
        { match: { task: 'T1', step: 'repair' }, behaviour: 'oscillate' },
      ],
    });
    await runSim(sim);
    expect(ofType(sim, 'stall.detected').map((e) => e.data.reason)).toContain('oscillation');
  });
  it('the same finding open after two repairs stalls', async () => {
    let n = 0;
    const script: any[] = [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'ok',
        edits: [{ path: 'src/t1/a.txt', content: 'w\n' }],
      },
    ];
    for (let i = 0; i < 6; i++) {
      script.push(
        fail({ args: { findings: [{ subject: 'same one', observed: `o${n++}` }] }, times: 1 }),
      );
      script.push({
        match: { task: 'T1', step: 'repair' },
        behaviour: 'ok',
        edits: [{ path: 'src/t1/a.txt', content: `r${i}\n` }],
        times: 1,
      });
    }
    const sim = makeSim({ script });
    await runSim(sim);
    expect(ofType(sim, 'stall.detected')[0].data.reason).toBe('same_finding');
  });
  it('the first stall switches rung once, and the second escalates', async () => {
    const sim = makeSim({
      script: [fail(), { match: { task: 'T1', step: 'repair' }, behaviour: 'no_change' }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    const rec = sim.engine.s.tasks.T1;
    expect(rec.stalls).toBe(2);
    expect(rec.repair_rung_switches).toBe(1);
    expect(rec.escalation_reason).toBe('REPAIR_EXHAUSTED');
    const rungs = sim.adapter.log
      .filter((x) => x.task === 'T1' && x.step === 'repair')
      .map((x) => x.rung);
    expect(new Set(rungs).size).toBe(2);
  });
  it('minor and nit findings trigger no repair, and FAIL with only those is invalid', async () => {
    const sim = makeSim({
      script: [
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_inconsistent',
          args: { kind: 'fail_no_blocker' },
          times: 1,
        },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.tasks.T1.repairs).toBe(0);
    expect(ofType(sim, 'review.invalid').length).toBe(1);
  });
  it('infrastructure failures charge no repair', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'outage', times: 1 }],
    });
    await runSim(sim);
    expect(sim.engine.s.tasks.T1.repairs).toBe(0);
  });
  it('the repair brief carries finding, gate and allowed scope, and never the worker reasoning', async () => {
    const sim = makeSim({
      script: [
        fail({
          args: { findings: [{ subject: 'the bad path', required_repair: 'fix the bad path' }] },
          times: 1,
        }),
      ],
    });
    await runSim(sim);
    const repair = Object.values(sim.engine.s.attempts).find((a) => a.step === 'repair') as any;
    const brief = sim.store.read(`attempts/${repair.attempt_id}/brief.txt`) as string;
    expect(brief).toContain('repair_brief');
    expect(brief).toContain('fix the bad path');
    expect(brief).toContain('src/t1/**');
  });
});
