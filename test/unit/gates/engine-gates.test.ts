import { describe, expect, it } from 'vitest';
import { SimulatedKill } from '../../../src/core/ports.ts';
import { replay } from '../../../src/core/reducer.ts';
import { events, makeSim, ofType, resumeSim, runSim } from '../../support/harness.ts';

const finalState = (s: ReturnType<typeof makeSim>) => s.engine.s;

describe('hard gates enforced by the engine, not only by a helper', () => {
  it('H-REPO: a wrong repository identity fails preflight', async () => {
    const sim = makeSim();
    sim.spec.target.repo_identity = 'f'.repeat(40);
    expect((await runSim(sim)).state).toBe('FAILED');
    expect(finalState(sim).reason).toContain('H-REPO');
  });
  it('H-REPO: an absent base commit fails preflight', async () => {
    const sim = makeSim();
    sim.spec.target.base_commit = 'f'.repeat(40);
    expect((await runSim(sim)).state).toBe('FAILED');
  });
  it('H-CLEAN: a dirty target fails preflight', async () => {
    const sim = makeSim();
    sim.git.clean = false;
    expect((await runSim(sim)).state).toBe('FAILED');
    expect(finalState(sim).reason).toContain('H-CLEAN');
  });
  it('H-NOPUSH: a remote visible to workers fails preflight', async () => {
    const sim = makeSim();
    sim.git.remotesList = ['origin'];
    expect((await runSim(sim)).state).toBe('FAILED');
    expect(finalState(sim).reason).toContain('H-NOPUSH');
  });
  it('H-SPEC: a tampered spec.lock fails the run at the next worker exit', async () => {
    const sim = makeSim();
    const orig = sim.store.write.bind(sim.store);
    sim.store.write = (rel, content) => {
      if (rel.endsWith('/raw.json')) orig('spec.lock', JSON.stringify({ sha256: 'tampered' }));
      orig(rel, content);
    };
    expect((await runSim(sim)).state).toBe('FAILED');
    expect(ofType(sim, 'invariant.violation')[0].data.message).toContain('H-SPEC');
  });
  it('H-SPEC: a spec changed in memory fails the run', async () => {
    const sim = makeSim();
    const orig = sim.store.write.bind(sim.store);
    sim.store.write = (rel, content) => {
      if (rel.endsWith('/raw.json')) sim.spec.goal = 'changed';
      orig(rel, content);
    };
    expect((await runSim(sim)).state).toBe('FAILED');
  });
  it('H-CAP: stops at exactly the cap, before each dispatch', async () => {
    const sim = makeSim({
      policy: (p) => {
        p.settings.caps.run.invocations = 2;
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_BUDGET');
    expect(sim.engine.s.counters.invocations).toBe(2);
  });
  it('H-CAP: with parallel tasks, the cap still holds exactly', async () => {
    const sim = makeSim({
      policy: (p) => {
        p.settings.caps.run.invocations = 3;
      },
    });
    await runSim(sim);
    expect(sim.engine.s.counters.invocations).toBe(3);
  });
  it('H-REVIEW-RO: a reviewer that changes its checkout is discarded and its rung quarantined', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_modifies_tree', times: 1 },
      ],
    });
    await runSim(sim);
    expect(ofType(sim, 'worker.quarantined').length).toBe(1);
    const rec = sim.engine.s.tasks.T1;
    expect(rec.reviews.every((r) => r.rung !== 'mock-anthropic')).toBe(true);
  });
  it('H-EVIDENCE: a gate log edited after the fact fails the run at commit', async () => {
    const sim = makeSim();
    const read = sim.store.read.bind(sim.store);
    sim.store.read = (rel) =>
      rel.startsWith('evidence/') && rel.endsWith('.log') ? 'edited' : read(rel);
    expect((await runSim(sim)).state).toBe('FAILED');
    expect(ofType(sim, 'invariant.violation')[0].data.message).toContain('H-EVIDENCE');
  });
  it('H-AC: a failing acceptance command never completes', async () => {
    const sim = makeSim({
      spec: {
        acceptance_criteria: [
          {
            id: 'AC-1',
            text: 't',
            human_reserved: false,
            verify: [{ kind: 'command', command: ['sim', 'accept'], timeout_s: 5 }],
          },
        ],
      },
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'ok',
          edits: [
            { path: 'src/t1/x.txt', content: 'x\n' },
            { path: 'src/t1/y.txt', content: 'y\n' },
          ],
        },
      ],
    });
    const orig = sim.runner.run.bind(sim.runner);
    sim.runner.run = async (argv, o) =>
      argv[1] === 'accept'
        ? { code: 1, log: 'Error: no', duration_ms: 1, timed_out: false }
        : orig(argv, o);
    const exit = await runSim(sim);
    expect(exit.state).not.toBe('MOCK_RUN_COMPLETE');
    expect(exit.state).toBe('ESCALATION_REQUIRED');
  });
  it('an observer that throws changes nothing about the run', async () => {
    const baseline = makeSim();
    await runSim(baseline);
    const observer = {
      onDecision() {
        throw new Error('shadow unavailable');
      },
      drain: async () => {
        throw new Error('nope');
      },
      poll() {
        throw new Error('nope');
      },
      nextWake(): number | null {
        throw new Error('nope');
      },
    };
    const sim = makeSim({ observer });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.counters.invocations).toBe(baseline.engine.s.counters.invocations);
  });
  it("an observer that never drains can't hold the run open past the end-of-run wait", async () => {
    const observer = {
      onDecision() {},
      drain: () => new Promise<void>(() => {}),
      poll() {},
      nextWake: () => null,
    };
    const sim = makeSim({ observer });
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
  });
});

describe('review coverage uses the real changed files', () => {
  it('rejects a reviewer that omits a changed file', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_incomplete', times: 1 },
      ],
    });
    const exit = await runSim(sim);
    expect(ofType(sim, 'review.invalid').length).toBe(1);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
  it('gives the reviewer the actual file list', async () => {
    const sim = makeSim();
    await runSim(sim);
    const run = sim.engine.s.tasks.T1.gate_runs[0];
    expect(run.changed?.map((f) => f.path)).toEqual(['src/t1/T1-1.txt']);
  });
});

// Simulates dying at a named boundary: the failpoint throws past the engine, whose objects are dropped.
async function crashThenResume(point: string, script: any[] = [], over: any = {}) {
  const sim = makeSim({ script, ...over });
  let armed = true;
  sim.failFn = (n) => {
    if (armed && n === point) {
      armed = false;
      throw new SimulatedKill(point);
    }
  };
  sim.engine.createRun();
  try {
    await sim.engine.loop();
  } catch (err) {
    if (!(err instanceof SimulatedKill)) throw err;
  }
  sim.failFn = () => {};
  return { sim, exit: await resumeSim(sim) };
}

describe('restart safety inside collection', () => {
  it('a crash after a worker result, before its snapshot, still gates that tree', async () => {
    const script: any[] = [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret' }];
    const baseline = makeSim({ script });
    expect((await runSim(baseline)).state).toBe('ESCALATION_REQUIRED');
    for (const point of [
      'after:dispatch.finished',
      'after:dispatch.orphans_swept',
      'after:snapshot.recorded',
      'after:dispatch.classified',
    ]) {
      const { exit, sim } = await crashThenResume(point, script);
      expect(exit.state, point).toBe('ESCALATION_REQUIRED');
      expect(sim.engine.s.tasks.T1.escalation_reason, point).toBe('HARD_GATE_BREACH');
    }
  });
  it('a crash part-way through opening planned tasks opens each once', async () => {
    const { exit, sim } = await crashThenResume('after:task.state_changed#1');
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.task_order.sort()).toEqual(['T1', 'T2', 'T3']);
  });
  it('a crash at plan.accepted still reaches the same end', async () => {
    const { exit } = await crashThenResume('after:plan.accepted');
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
  it('a crash after review.collected counts the review once, and routes a FAIL', async () => {
    const script = [
      { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
    ];
    const { exit, sim } = await crashThenResume('after:review.collected', script);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.tasks.T1.repairs).toBe(1);
    expect(sim.engine.s.tasks.T1.reviews.filter((r) => r.effective === 'FAIL').length).toBe(1);
  });
  it('retry_integration survives a crash, because it is on the ledger', () => {
    const s0 = replay([
      {
        schema: 'event.v1',
        seq: 0,
        at: '2026-01-01T00:00:00Z',
        run_id: 'r',
        task_id: null,
        type: 'operator.decision',
        data: {
          escalation_id: 'E-1',
          option_id: 'retry_integration',
          note: 'try again',
          reset_integrated_repairs: true,
        },
        prev: '',
        hash: 'x',
      },
    ]);
    expect(s0.pending_retry_integration).toBe('try again');
  });
  it('acceptance evidence comes from the ledger, for this verification only', () => {
    const ev = (type: any, data: any, seq: number) => ({
      schema: 'event.v1' as const,
      seq,
      at: '2026-01-01T00:00:00Z',
      run_id: 'r',
      task_id: null,
      type,
      data,
      prev: '',
      hash: 'x',
    });
    const s1 = replay([
      ev(
        'review.collected',
        { stage: 'acceptance', passed_acs: ['AC-1'], review_id: 'R', verdict: 'PASS', slot: 0 },
        0,
      ),
    ]);
    expect(s1.verify.accepted).toEqual(['AC-1']);
    const s2 = replay([
      ev(
        'review.collected',
        { stage: 'acceptance', passed_acs: ['AC-1'], review_id: 'R', verdict: 'PASS', slot: 0 },
        0,
      ),
      {
        ...ev(
          'run.state_changed',
          { from: 'CREATED', to: 'PREFLIGHT', trigger: 'lock_acquired' },
          1,
        ),
      },
    ]);
    expect(s2.verify.accepted).toEqual(['AC-1']);
  });
});

describe('cleanup after a worker exits', () => {
  it('scans, kills and confirms before a family is released', async () => {
    const scans: string[] = [];
    let alive = true;
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'crash_midway', times: 1 }],
    });
    sim.ports.scanner = {
      scan: async (a) => {
        scans.push(a.attempt_id);
        return alive && a.attempt_id === 'A-0002'
          ? [{ pid: 5, start_time: null, argv: 'x', cwd: null }]
          : [];
      },
      isAlive: async () => alive,
    };
    const killed: string[] = [];
    sim.ports.killer = {
      kill: async (_p, sig) => {
        killed.push(sig);
        alive = false;
      },
      sleep: async () => {},
    };
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(killed).toEqual(['SIGTERM']);
    const types = ofType(sim, 'dispatch.orphans_swept').filter(
      (e) => e.data.attempt_id === 'A-0002',
    );
    expect(types[0].data.found).toBe(1);
    const order = events(sim).map((e) => e.type);
    const released = order.indexOf('reservation.released');
    expect(released).toBeGreaterThan(order.indexOf('dispatch.orphans_swept'));
  });
  it('fails the run rather than proceed when a process will not die', async () => {
    const sim = makeSim();
    sim.ports.scanner = {
      scan: async () => [{ pid: 5, start_time: null, argv: 'x', cwd: null }],
      isAlive: async () => true,
    };
    const exit = await runSim(sim);
    expect(exit.state).toBe('FAILED');
    expect(ofType(sim, 'invariant.violation')[0].data.message).toContain('live processes');
  });
});

describe('agent rulings bind to what was disputed', () => {
  it('a ruling on one disputed finding waives no other finding', async () => {
    const a = { criterion: 'AC-1', subject: 'first', observed: 'o1', expected: 'e1' };
    const b = { criterion: 'AC-1', subject: 'second', observed: 'o2', expected: 'e2' };
    const sim = makeSim({
      script: [
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_fail',
          args: { findings: [a, b] },
          times: 1,
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'dispute_finding',
          args: { only_first: true },
          times: 1,
        },
        {
          match: { task: 'T1', step: 'adjudicate' },
          behaviour: 'adjudicate',
          args: { ruling: 'override' },
        },
      ],
    });
    await runSim(sim);
    const waived = sim.engine.s.waivers
      .filter((w: any) => w.kind === 'finding')
      .map((w: any) => w.resolves.finding_fingerprint);
    const unique = [...new Set(waived)];
    expect(unique.length).toBeGreaterThan(0);
    for (const fp of unique) expect(String(fp)).toContain('first');
  });
});
