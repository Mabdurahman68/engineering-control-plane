import { describe, expect, it } from 'vitest';
import { makeSim, ofType, resumeSim, runSim, decision } from '../../support/harness.ts';

const wide: any = {
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
};
const softEdits = [
  { path: 'src/a.txt', content: 'a\n' },
  { path: '.sim/fail/full', content: 'Error: regression\n' },
];
const deep = { requested_depth: 'DEEP' as const };
const disagreements = (sim: any, kind?: string) =>
  Object.values<any>(sim.engine.s.disagreements).filter((d) => !kind || d.kind === kind);

describe('MECHANICAL_PASS + SEMANTIC_FAIL', () => {
  it('always writes a record, routed to repair with no adjudication', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 }],
    });
    await runSim(sim);
    const [d] = disagreements(sim, 'MECHANICAL_PASS_SEMANTIC_FAIL');
    expect(d.adjudication.status).toBe('ROUTED_TO_REPAIR');
    expect(sim.adapter.log.some((x) => x.step === 'adjudicate')).toBe(false);
  });
  it('a dispute without evidence is dropped, and gates still ran on the diff', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
        { match: { task: 'T1', step: 'repair' }, behaviour: 'dispute_no_evidence', times: 1 },
      ],
    });
    await runSim(sim);
    expect(sim.adapter.log.some((x) => x.step === 'adjudicate')).toBe(false);
    expect(ofType(sim, 'gate.finished').filter((e) => e.task_id === 'T1').length).toBe(2);
    const classified = ofType(sim, 'dispatch.classified').filter(
      (e) => e.data.rejected_disputes === 1,
    );
    expect(classified.length).toBe(1);
  });
  it("a dispute of a finding not in the worker's own brief is dropped", async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'dispute_finding',
          args: { spoof: 'not|a|real|finding' },
          times: 1,
        },
      ],
    });
    await runSim(sim);
    expect(sim.adapter.log.some((x) => x.step === 'adjudicate')).toBe(false);
  });
  it('a dispute with evidence is adjudicated; its diff is still gated', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
        { match: { task: 'T1', step: 'repair' }, behaviour: 'dispute_finding', times: 1 },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'reject' },
        },
      ],
    });
    await runSim(sim);
    expect(sim.adapter.log.filter((x) => x.step === 'adjudicate').length).toBe(1);
    expect(
      ofType(sim, 'gate.finished').filter((e) => e.task_id === 'T1').length,
    ).toBeGreaterThanOrEqual(2);
  });
  it('one adjudication per fingerprint: a second dispute of it is not accepted', async () => {
    const edits = [{ path: 'src/t1/a.txt', content: 'a\n' }];
    const f = {
      criterion: 'AC-1',
      file: 'src/t1/a.txt',
      subject: 's',
      observed: 'o',
      expected: 'e',
    };
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits },
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_fail',
          args: { findings: [f] },
          times: 2,
        },
        { match: { task: 'T1', step: 'repair' }, behaviour: 'dispute_finding', edits, times: 2 },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'reject' },
        },
      ],
    });
    await runSim(sim);
    expect(sim.adapter.log.filter((x) => x.step === 'adjudicate').length).toBe(1);
  });
});

describe('GATE_FAIL + AGENT_CHALLENGE', () => {
  const challenge = (ruling: string) =>
    [
      { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits: softEdits },
      { match: { task: 'T1', step: 'challenge' }, behaviour: 'challenge_file' },
      { match: { task: 'T1', step: 'adjudicate' }, behaviour: 'adjudicate', args: { ruling } },
      {
        match: { task: 'T1', step: 'repair' },
        behaviour: 'ok',
        edits: [
          { path: 'src/a.txt', content: 'b\n' },
          { path: '.sim/fail/full', content: null },
        ],
      },
    ] as any[];
  it('waived: the gate reports WAIVED on the next run, the review goes ahead', async () => {
    const sim = makeSim({ plan: wide, spec: deep, script: challenge('waive') });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const runs = sim.engine.s.tasks.T1.gate_runs;
    expect(runs[0].results.find((r) => r.id === 'S-REGRESSION')?.status).toBe('FAIL');
    expect(runs[runs.length - 1].results.find((r) => r.id === 'S-REGRESSION')?.status).toBe(
      'WAIVED',
    );
  });
  it('a task waiver carries to integrated verification', async () => {
    const sim = makeSim({ plan: wide, spec: deep, script: challenge('waive') });
    await runSim(sim);
    const integrated = ofType(sim, 'gate.finished').filter((e) => e.data.integrated)[0].data
      .results as any[];
    expect(integrated.find((r) => r.id === 'S-REGRESSION').status).toBe('WAIVED');
  });
  it('rejected: goes to repair', async () => {
    const sim = makeSim({ plan: wide, spec: deep, script: challenge('reject') });
    await runSim(sim);
    expect(sim.engine.s.tasks.T1.repairs).toBe(1);
  });
  it('split: escalates as UNRESOLVED_DISAGREEMENT', async () => {
    const sim = makeSim({ plan: wide, spec: deep, script: challenge('split') });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(sim.engine.s.tasks.T1.escalation_reason).toBe('UNRESOLVED_DISAGREEMENT');
  });
  it('no challenge goes straight to repair', async () => {
    const sim = makeSim({
      plan: wide,
      spec: deep,
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits: softEdits },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: '.sim/fail/full', content: null }],
        },
      ],
    });
    await runSim(sim);
    expect(sim.engine.s.tasks.T1.repairs).toBe(1);
  });
  it('a new signature fails afresh after a waiver', async () => {
    const sim = makeSim({
      plan: wide,
      spec: deep,
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits: softEdits },
        { match: { task: 'T1', step: 'challenge' }, behaviour: 'challenge_file', times: 1 },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'waive' },
        },
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: '.sim/fail/full', content: 'Error: a different failure\n' }],
          times: 1,
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: '.sim/fail/full', content: null }],
        },
      ],
    });
    await runSim(sim);
    const runs = sim.engine.s.tasks.T1.gate_runs;
    const statuses = runs.map((r) => r.results.find((x) => x.id === 'S-REGRESSION')?.status);
    expect(statuses).toContain('WAIVED');
    expect(statuses.slice(statuses.lastIndexOf('WAIVED') + 1)).toContain('FAIL');
  });
  it('two soft gates, one waived: the other still fails', async () => {
    const sim = makeSim({
      plan: wide,
      spec: { ...deep, gate_commands: { lint: { command: ['sim', 'lint'], timeout_s: 5 } } },
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'ok',
          edits: [...softEdits, { path: '.sim/fail/lint', content: 'Error: lint\n' }],
        },
        {
          match: { task: 'T1', step: 'challenge' },
          behaviour: 'challenge_file',
          args: { gates: ['S-LINT'] },
        },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'waive' },
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: '.sim/fail/full', content: null }],
        },
      ],
    });
    await runSim(sim);
    const runs = sim.engine.s.tasks.T1.gate_runs;
    const second = runs[1].results;
    expect(second.find((x) => x.id === 'S-LINT')?.status).toBe('WAIVED');
    expect(second.find((x) => x.id === 'S-REGRESSION')?.status).toBe('FAIL');
    expect(sim.engine.s.tasks.T1.repairs).toBeGreaterThanOrEqual(1);
  });
  it('a hard gate is never adjudicated', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'edit_out_of_scope', times: 1 },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [
            { path: 'outside/oops.txt', content: null },
            { path: 'src/t1/a.txt', content: 'a\n' },
          ],
        },
      ],
    });
    await runSim(sim);
    expect(sim.adapter.log.some((x) => x.step === 'challenge' || x.step === 'adjudicate')).toBe(
      false,
    );
    expect(sim.engine.s.tasks.T1.repairs).toBe(1);
  });
});

describe('risk limits on rulings', () => {
  it('critical: a soft-gate challenge escalates, with no agent waiver', async () => {
    const sim = makeSim({
      plan: wide,
      spec: { requested_depth: 'EXHAUSTIVE', declared_risk: 'critical' },
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits: softEdits },
        { match: { task: 'T1', step: 'challenge' }, behaviour: 'challenge_file' },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(sim.engine.s.waivers.length).toBe(0);
    expect(sim.adapter.log.some((x) => x.step === 'adjudicate')).toBe(false);
  });
  it('high: an agent may waive', async () => {
    const sim = makeSim({
      plan: wide,
      spec: { requested_depth: 'DEEP', declared_risk: 'high' },
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', edits: softEdits },
        { match: { task: 'T1', step: 'challenge' }, behaviour: 'challenge_file' },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'waive' },
        },
      ],
    });
    await runSim(sim);
    expect(sim.engine.s.waivers.length).toBeGreaterThan(0);
  });
  it('two-reviewer split at critical reaches REVIEWER_REVIEWER, then the owner', async () => {
    const sim = makeSim({
      spec: { requested_depth: 'EXHAUSTIVE', declared_risk: 'critical' },
      script: [
        {
          match: { task: 'T1', step: 'review', rung: 'mock-anthropic' },
          behaviour: 'reviewer_pass',
          times: 1,
        },
        {
          match: { task: 'T1', step: 'review', rung: 'mock-glm' },
          behaviour: 'reviewer_fail',
          times: 1,
        },
      ],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(disagreements(sim, 'REVIEWER_REVIEWER').length).toBe(1);
  });
});

describe('adjudicator family', () => {
  const dispute: any[] = [
    { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
    { match: { task: 'T1', step: 'repair' }, behaviour: 'dispute_finding', times: 1 },
    {
      match: { task: 'T1', step: 'adjudicate' },
      behaviour: 'adjudicate',
      args: { ruling: 'reject' },
    },
  ];
  it('is outside the authors, the filer and the disputed reviewer', async () => {
    const sim = makeSim({ script: dispute });
    await runSim(sim);
    const adj = sim.adapter.log.find((x) => x.step === 'adjudicate');
    expect(sim.engine.family(adj?.rung as string)).toBe('glm');
  });
  it('no family could ever qualify: escalates', async () => {
    const sim = makeSim({
      script: dispute,
      policy: (p) => {
        p.workers.ladders.adjudication = ['mock-anthropic', 'mock-openai'];
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(sim.engine.s.tasks.T1.escalation_reason).toBe('UNRESOLVED_DISAGREEMENT');
  });
  it('a family that qualifies but is unavailable now: the task waits', async () => {
    const sim = makeSim({
      script: dispute,
      probes: {},
    });
    const orig = sim.adapter.probe.bind(sim.adapter);
    sim.adapter.probe = async (r) => {
      const h = await orig(r);
      return r.includes('glm') && sim.adapter.log.some((x) => x.step === 'repair')
        ? { ...h, installed: false }
        : h;
    };
    sim.engine.health.clear();
    sim.clock.advance(0);
    const exit = await runSim(sim);
    expect(['PAUSED_NO_WORKER', 'MOCK_RUN_COMPLETE']).toContain(exit.state);
  });
  it('never sees the filer in its brief', async () => {
    const sim = makeSim({ script: dispute });
    await runSim(sim);
    const a = Object.values(sim.engine.s.attempts).find((x) => x.step === 'adjudicate') as any;
    const data = (sim.store.read(`attempts/${a.attempt_id}/brief.txt`) as string)
      .split('<data label="disagreement">')[1]
      .split('</data>')[0];
    expect(data).not.toContain('filed_by');
  });
  it('T-INT: authors(integrated) are excluded too', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 1 }],
    });
    await runSim(sim);
    const t = sim.engine.s.tasks['T-INT-1'];
    const rev = t.reviews[0];
    expect(sim.engine.authorsIntegrated()).not.toContain(rev.family);
  });
});

describe('owner rulings on disagreements', () => {
  const unresolved: any[] = [
    { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
    { match: { task: 'T1', step: 'repair' }, behaviour: 'dispute_finding', times: 1 },
    {
      match: { task: 'T1', step: 'adjudicate' },
      behaviour: 'adjudicate',
      args: { ruling: 'split' },
    },
  ];
  it('override: recorded, and the task goes on', async () => {
    const sim = makeSim({ script: unresolved });
    expect((await runSim(sim)).state).toBe('ESCALATION_REQUIRED');
    const id = sim.engine.s.open_escalation as string;
    const exit = await resumeSim(sim, { decision: decision(id, 'override') });
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.waivers.length).toBeGreaterThan(0);
  });
  it('reject: goes to repair, with the counter reset', async () => {
    const sim = makeSim({ script: unresolved });
    await runSim(sim);
    const id = sim.engine.s.open_escalation as string;
    const exit = await resumeSim(sim, { decision: decision(id, 'reject') });
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
  it('a decision not on the list is refused', async () => {
    const sim = makeSim({ script: unresolved });
    await runSim(sim);
    const id = sim.engine.s.open_escalation as string;
    await expect(resumeSim(sim, { decision: decision(id, 'approve') })).rejects.toThrow(
      /isn't an option/,
    );
  });
  it('a hard-gate breach offers no waive option', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret' }],
    });
    await runSim(sim);
    const rec = sim.engine.s.escalations[sim.engine.s.open_escalation as string];
    expect(rec.reason).toBe('HARD_GATE_BREACH');
    expect(rec.options.map((o: any) => o.id)).toEqual(['retry_task', 'abandon']);
  });
});

describe('claim contradiction records', () => {
  it('a reviewer never overrides mechanical evidence: the gate result stands', async () => {
    const plan: any = {
      ...wide,
      tasks: [{ ...wide.tasks[0], required_tests: ['unit'] }, wide.tasks[1]],
    };
    const sim = makeSim({
      plan,
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'ok',
          edits: [
            { path: 'src/a.txt', content: 'a\n' },
            { path: '.sim/fail/unit', content: 'Error: unit\n' },
          ],
          times: 1,
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: '.sim/fail/unit', content: null }],
        },
      ],
    });
    await runSim(sim);
    expect(
      sim.engine.s.tasks.T1.gate_runs[0].results.find((r) => r.id === 'H-TESTS-PASS')?.status,
    ).toBe('FAIL');
    expect(sim.engine.s.tasks.T1.reviews.length).toBe(1);
  });
});
