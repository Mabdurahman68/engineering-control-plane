import { describe, expect, it } from 'vitest';
import { SimulatedKill } from '../../../src/core/ports.ts';
import { replay } from '../../../src/core/reducer.ts';
import { decision, events, makeSim, ofType, resumeSim, runSim } from '../../support/harness.ts';

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

describe('crash boundaries found at MIDPOINT re-review', () => {
  const fail = [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 1 }] as any[];
  it('a crash after classifying an acceptance FAIL still repairs once', async () => {
    const plain = makeSim({ script: fail });
    await runSim(plain);
    expect(plain.engine.s.integrated_repairs).toBe(1);
    for (const point of ['after:review.collected']) {
      const { sim, exit } = await crashThenResume(point, fail);
      expect(exit.state).toBe(plain.engine.s.state);
      expect(sim.engine.s.integrated_repairs, point).toBe(1);
    }
    const count = ofType(plain, 'dispatch.classified').length;
    for (let n = 1; n <= count; n += 3) {
      const { sim, exit } = await crashThenResume(`after:dispatch.classified#${n}`, fail);
      expect(exit.state, `#${n}`).toBe('MOCK_RUN_COMPLETE');
      expect(sim.engine.s.integrated_repairs, `#${n}`).toBe(1);
    }
  });
  it('a crash after the owner decision completes it on resume', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret', times: 1 }],
    });
    expect((await runSim(sim)).state).toBe('ESCALATION_REQUIRED');
    const id = sim.engine.s.open_escalation as string;
    let armed = true;
    sim.failFn = (n) => {
      if (armed && n === 'after:operator.decision') {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    await expect(resumeSim(sim, { decision: decision(id, 'retry_task') })).rejects.toBeInstanceOf(
      SimulatedKill,
    );
    sim.failFn = () => {};
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(ofType(sim, 'operator.decision').length).toBe(1);
  });
  it('cancel sweeps an attempt left from before a crash', async () => {
    const { sim } = await crashAfter('after:dispatch.finished#1');
    const scanned: string[] = [];
    sim.ports.scanner = {
      scan: async (a) => {
        scanned.push(a.attempt_id);
        return [];
      },
      isAlive: async () => false,
    };
    sim.control = { request: 'cancel' };
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('CANCELLED');
    expect(scanned.length).toBeGreaterThan(0);
    for (const a of Object.values(sim.engine.s.attempts))
      expect(a.swept || a.fenced, a.attempt_id).toBe(true);
  });
  it('H-SPEC holds on a finished attempt collected after a crash', async () => {
    const { sim } = await crashAfter('after:dispatch.finished#2');
    sim.store.write('spec.lock', JSON.stringify({ sha256: 'tampered' }));
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('FAILED');
    expect(ofType(sim, 'invariant.violation')[0].data.message).toContain('H-SPEC');
  });
  it('a modified review checkout is rejected even if the crash fell after its check', async () => {
    const script: any[] = [
      { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_modifies_tree', times: 1 },
    ];
    const { sim, exit } = await crashThenResume('after:tree.identity_checked#1', script);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(ofType(sim, 'worker.quarantined').length).toBe(1);
  });
  it('a checkout that vanished with no recorded check discards the output', async () => {
    const sim = makeSim();
    let armed = true;
    sim.failFn = (n) => {
      if (armed && n === 'after:dispatch.finished#1') {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    const open = Object.values(sim.engine.s.attempts).find(
      (a) => a.finished && a.class === null && a.mode === 'read_only',
    );
    expect(open).toBeTruthy();
    await sim.git.removeWorktree((open as any).cwd);
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(ofType(sim, 'attempt.result_fenced').length).toBeGreaterThan(0);
  });
  it('a re-attached relay past its deadline goes down the kill path', async () => {
    const script: any[] = [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'ok',
        delay_ms: 10_000_000,
        survives_coordinator: true,
        times: 1,
      },
    ];
    const sim = makeSim({ script });
    let armed = true;
    sim.failFn = (n) => {
      if (armed && n === 'after:dispatch.started#2') {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    const a = Object.values(sim.engine.s.attempts).find(
      (x) => x.step === 'work' && !x.finished,
    ) as any;
    const signals: string[] = [];
    let alive = true;
    sim.ports.scanner = {
      scan: async () =>
        alive
          ? [{ pid: a.pid, start_time: a.start_time, argv: `relay ${a.out_dir}`, cwd: null }]
          : [],
      isAlive: async () => alive,
    };
    sim.ports.killer = {
      kill: async (_p, sig) => {
        signals.push(sig);
        alive = false;
      },
      sleep: async () => {},
    };
    sim.clock.advance(a.timeout_s * 1000 + 120_000);
    const exit = await resumeSim(sim);
    expect(signals).toEqual(['SIGTERM']);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
  it('a relay proven live is re-attached with no signal, then killed if it passes its deadline', async () => {
    const script: any[] = [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'ok',
        delay_ms: 100_000_000,
        survives_coordinator: true,
        times: 1,
      },
    ];
    const sim = makeSim({ script });
    let armed = true;
    sim.failFn = (n) => {
      if (armed && n === 'after:dispatch.started#2') {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    const a = Object.values(sim.engine.s.attempts).find(
      (x) => x.step === 'work' && !x.finished,
    ) as any;
    let alive = true;
    const signals: string[] = [];
    sim.ports.scanner = {
      scan: async () =>
        alive
          ? [{ pid: a.pid, start_time: a.start_time, argv: `relay ${a.out_dir}`, cwd: null }]
          : [],
      isAlive: async () => alive,
    };
    sim.ports.killer = {
      kill: async (_p, sig) => {
        signals.push(sig);
        alive = false;
      },
      sleep: async () => {},
    };
    const exit = await resumeSim(sim);
    const cancels = ofType(sim, 'cancel.sent').filter((e) => e.data.reason === 'deadline');
    expect(cancels.length).toBe(1);
    expect(signals).toEqual(['SIGTERM']);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
  });
});

describe('crash boundaries found at MIDPOINT re-review 3', () => {
  it('a task-level split replayed after a crash still reaches the owner', async () => {
    const script: any[] = [
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
    ];
    const sim = makeSim({
      script,
      spec: { declared_risk: 'critical', requested_depth: 'EXHAUSTIVE' },
    });
    let armed = true;
    sim.failFn = (n) => {
      const rec = sim.engine.s.tasks.T1;
      if (armed && n === 'after:dispatch.classified' && rec?.reviews.at(-1)?.effective === 'FAIL') {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(Object.values<any>(sim.engine.s.escalations)[0].reason).toBe('UNRESOLVED_DISAGREEMENT');
    expect(
      Object.values<any>(sim.engine.s.disagreements).some((d) => d.kind === 'REVIEWER_REVIEWER'),
    ).toBe(true);
  });
  it('a stalled rung stays off the list after a crash, and with no alternate the task waits', async () => {
    const script: any[] = [
      { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail' },
      { match: { task: 'T1', step: 'repair' }, behaviour: 'no_change' },
    ];
    const sim = makeSim({ script });
    let armed = true;
    sim.failFn = (n) => {
      if (armed && n === 'after:repair.requested' && sim.engine.s.tasks.T1.stalls === 1) {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    const stalled = sim.engine.s.tasks.T1.rung as string;
    const before = sim.adapter.log.filter((x) => x.task === 'T1' && x.step === 'repair').length;
    for (const r of Object.keys(sim.policy.workers.rungs))
      if (r !== stalled) sim.adapter.setProbe(r, 'not_installed');
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('PAUSED_NO_WORKER');
    expect(sim.adapter.log.filter((x) => x.task === 'T1' && x.step === 'repair').length).toBe(
      before,
    );
    expect(sim.engine.s.tasks.T1.state).toBe('TASK_WAITING_WORKER');
  });
  it('a crash during a rate-limit fallback counts one backoff', async () => {
    const script: any[] = [
      { match: { task: 'T1', step: 'work' }, behaviour: 'rate_limit', times: 1 },
    ];
    for (const point of ['after:fallback.taken', 'after:backoff.started']) {
      const { sim } = await crashAfter(point, script);
      await resumeSim(sim);
      const tries = Object.values<any>(sim.engine.s.backoff).map((b) => b.tries);
      expect(tries, point).toEqual([1]);
    }
  });
});

describe('crash boundaries found at MIDPOINT re-review 2', () => {
  const armOn = (sim: ReturnType<typeof makeSim>, when: (name: string) => boolean) => {
    let armed = true;
    sim.failFn = (n) => {
      if (armed && when(n)) {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
  };
  const twoSlotHigh = (p: any) => {
    p.profiles.quorum.high = 2;
    p.workers.ladders.adjudication = ['mock-glm', 'mock-anthropic', 'mock-openai'];
  };
  const split: any[] = [
    { match: { step: 'acceptance', rung: 'mock-anthropic' }, behaviour: 'reviewer_pass', times: 1 },
    { match: { step: 'acceptance', rung: 'mock-glm' }, behaviour: 'reviewer_fail', times: 1 },
  ];
  it('a crash just after a split T-INT opens still records the disagreement', async () => {
    const sim = makeSim({ script: split, spec: { declared_risk: 'high' }, policy: twoSlotHigh });
    armOn(sim, () => Boolean(sim.engine.s.tasks['T-INT-1']));
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    await resumeSim(sim);
    const recs = Object.values(sim.engine.s.disagreements).filter(
      (d: any) => d.kind === 'REVIEWER_REVIEWER',
    );
    expect(recs.length).toBe(1);
  });
  it('a crash after classifying a tree-changing reviewer still quarantines it', async () => {
    const script: any[] = [
      { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_modifies_tree', times: 1 },
    ];
    const sim = makeSim({ script });
    armOn(
      sim,
      (n) =>
        n === 'after:dispatch.classified' &&
        Object.values(sim.engine.s.attempts).some((a) => a.tree_ok === false),
    );
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(ofType(sim, 'worker.quarantined').length).toBe(1);
    const reviews = sim.engine.s.tasks.T1.reviews;
    expect(reviews.every((r) => r.rung !== 'mock-anthropic')).toBe(true);
  });
  it('a crash before routing a split keeps the failing reviewer out of adjudication', async () => {
    const sim = makeSim({ script: split, spec: { declared_risk: 'high' }, policy: twoSlotHigh });
    armOn(
      sim,
      (n) => n === 'after:dispatch.classified' && Boolean(sim.engine.s.verify.pending_fail),
    );
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    await resumeSim(sim);
    const rec: any = Object.values(sim.engine.s.disagreements).find(
      (d: any) => d.kind === 'REVIEWER_REVIEWER',
    );
    expect(rec.filed_by).toBe('mock-glm');
    expect(rec.adjudication.adjudicator).not.toBe('mock-glm');
    expect(
      sim.adapter.log.filter((x) => x.step === 'adjudicate').every((x) => x.rung !== 'mock-glm'),
    ).toBe(true);
  });
  it('a spec-lock failure still sweeps the writer', async () => {
    const sim = makeSim();
    let alive = true;
    const signals: string[] = [];
    let tampered = false;
    const orig = sim.store.write.bind(sim.store);
    sim.store.write = (rel, content) => {
      if (
        rel.endsWith('/raw.json') &&
        sim.engine.s.attempts[rel.split('/')[1]]?.mode === 'write' &&
        !tampered
      ) {
        tampered = true;
        orig('spec.lock', JSON.stringify({ sha256: 'tampered' }));
      }
      orig(rel, content);
    };
    sim.ports.scanner = {
      scan: async () =>
        alive && tampered ? [{ pid: 9, start_time: null, argv: 'x', cwd: null }] : [],
      isAlive: async () => alive,
    };
    sim.ports.killer = {
      kill: async (_p, sig) => {
        signals.push(sig);
        alive = false;
      },
      sleep: async () => {},
    };
    const exit = await runSim(sim);
    expect(exit.state).toBe('FAILED');
    expect(signals).toEqual(['SIGTERM']);
    expect(ofType(sim, 'invariant.violation')[0].data.message).toContain('H-SPEC');
  });
});

async function crashAfter(point: string, script: any[] = []) {
  const sim = makeSim({ script });
  let armed = true;
  sim.failFn = (n) => {
    if (armed && n === point) {
      armed = false;
      throw new SimulatedKill(point);
    }
  };
  sim.engine.createRun();
  await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
  sim.failFn = () => {};
  return { sim };
}

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
