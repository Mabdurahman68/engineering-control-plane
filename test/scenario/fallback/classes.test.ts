import { describe, expect, it } from 'vitest';
import { fallbackPlan } from '../../../src/core/fallback.ts';
import { makeSim, ofType, resumeSim, runSim } from '../../support/harness.ts';

const T0 = 1_000_000;
const first = (o: any) => {
  const { rung, ...rest } = o;
  return { match: { task: 'T1', step: 'work' as const, ...(rung ? { rung } : {}) }, ...rest };
};

describe('fallback plan, row by row', () => {
  it('RATE_LIMIT: 60s, 180s, 600s, with jitter within 20%', () => {
    for (const [tries, base] of [
      [0, 60],
      [1, 180],
      [2, 600],
      [5, 600],
    ] as const) {
      for (const jitter of [0, 0.5, 0.999]) {
        const p = fallbackPlan('RATE_LIMIT', 0, T0, jitter, tries, null);
        const wait = (p.backoff_until as number) - T0;
        expect(wait).toBeGreaterThanOrEqual(base * 800);
        expect(wait).toBeLessThanOrEqual(base * 1200);
      }
    }
  });
  it('RATE_LIMIT honours a stated reset up to 15 minutes, and ignores a later one', () => {
    expect(fallbackPlan('RATE_LIMIT', 0, T0, 0.5, 0, T0 + 900_000).backoff_until).toBe(
      T0 + 900_000,
    );
    expect(fallbackPlan('RATE_LIMIT', 0, T0, 0.5, 0, T0 + 900_001).backoff_until).toBe(T0 + 60_000);
  });
  it('QUOTA: no same-rung retry; until the stated reset, otherwise 60 minutes', () => {
    const p = fallbackPlan('QUOTA', 0, T0, 0, 0, null);
    expect(p.retry_same).toBe(false);
    expect(p.quarantine_until).toBe(T0 + 3_600_000);
    expect(fallbackPlan('QUOTA', 0, T0, 0, 0, T0 + 5).quarantine_until).toBe(T0 + 5);
  });
  it('OUTAGE: once after 60 seconds, then a 15-minute quarantine', () => {
    const a = fallbackPlan('OUTAGE', 0, T0, 0, 0, null);
    expect([a.retry_same, a.delay_ms]).toEqual([true, 60_000]);
    const b = fallbackPlan('OUTAGE', 1, T0, 0, 0, null);
    expect([b.retry_same, b.quarantine_until]).toEqual([false, T0 + 900_000]);
  });
  it('TIMEOUT: once, then next', () => {
    expect(fallbackPlan('TIMEOUT', 0, T0, 0, 0, null).retry_same).toBe(true);
    expect(fallbackPlan('TIMEOUT', 1, T0, 0, 0, null).retry_same).toBe(false);
  });
  it('MALFORMED: re-ask once keeping the diff, then next', () => {
    const a = fallbackPlan('MALFORMED', 0, T0, 0, 0, null);
    expect([a.retry_same, a.keep_diff]).toEqual([true, true]);
    expect(fallbackPlan('MALFORMED', 1, T0, 0, 0, null).retry_same).toBe(false);
  });
  it('AUTH: no retry, quarantine for this run, flag the owner', () => {
    const p = fallbackPlan('AUTH', 0, T0, 0, 0, null);
    expect([p.retry_same, p.quarantine_until, p.flag_owner]).toEqual([false, 'run', true]);
  });
  it('RELAY_LOST: salvage and once more, then next', () => {
    const a = fallbackPlan('RELAY_LOST', 0, T0, 0, 0, null);
    expect([a.retry_same, a.salvage]).toEqual([true, true]);
    expect(fallbackPlan('RELAY_LOST', 1, T0, 0, 0, null).retry_same).toBe(false);
  });
  it('UNKNOWN: once, then next', () => {
    expect(fallbackPlan('UNKNOWN', 0, T0, 0, 0, null).retry_same).toBe(true);
    expect(fallbackPlan('UNKNOWN', 1, T0, 0, 0, null).retry_same).toBe(false);
  });
  it('is deterministic for a seed', () => {
    expect(fallbackPlan('RATE_LIMIT', 0, T0, 0.3, 1, null)).toEqual(
      fallbackPlan('RATE_LIMIT', 0, T0, 0.3, 1, null),
    );
  });
});

describe('fallback in a run, for a worker', () => {
  it.each([
    ['outage', 2, 'mock-glm'],
    ['unknown_failure', 2, 'mock-glm'],
    ['timeout', 2, 'mock-glm'],
    ['relay_lost', 2, 'mock-glm'],
    ['crash_midway', 2, 'mock-glm'],
    ['exit_nonzero', 2, 'mock-glm'],
    ['spawn_failure', 2, 'mock-glm'],
  ])('%s: retried exactly once on the rung, then the next', async (behaviour, tries, next) => {
    const sim = makeSim({ script: [first({ rung: 'mock-openai', behaviour })] });
    const m = sim.engine;
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const onFirst = sim.adapter.log.filter(
      (x) => x.task === 'T1' && x.step === 'work' && x.rung === 'mock-openai',
    ).length;
    expect(onFirst).toBe(tries);
    expect(m.s.tasks.T1.retained_families).toEqual([m.family(next)]);
    expect(m.s.tasks.T1.repairs).toBe(0);
  });
  it.each(['rate_limit', 'quota', 'auth'])('%s: straight to the next rung', async (behaviour) => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'work', rung: 'mock-openai' }, behaviour: behaviour as any },
      ],
    });
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.adapter.log.filter((x) => x.task === 'T1' && x.rung === 'mock-openai').length).toBe(
      1,
    );
    expect(sim.engine.s.tasks.T1.retained_families).toEqual(['glm']);
  });
  it('the OUTAGE retry waits its 60 seconds', async () => {
    const sim = makeSim({ script: [first({ behaviour: 'outage', times: 1 })] });
    const t0 = sim.clock.now();
    await runSim(sim);
    expect(sim.clock.now() - t0).toBeGreaterThanOrEqual(60_000);
  });
  it('AUTH flags the owner at once, and quarantines for the run', async () => {
    const sim = makeSim({
      script: [first({ behaviour: 'auth', times: 1 })],
      policy: (p) => {
        p.profiles.profiles.STANDARD.parallel_writers = 1;
      },
    });
    await runSim(sim);
    expect(sim.notifications.some((n) => n.kind === 'AUTH')).toBe(true);
    expect(sim.engine.s.quarantine['mock-openai'].until).toBeNull();
    expect(
      sim.adapter.log.filter(
        (x) => x.rung === 'mock-openai' && x.step === 'work' && x.task !== 'T1',
      ).length,
    ).toBe(0);
  });
  it('every move writes fallback.taken, with its class and reference', async () => {
    const sim = makeSim({ script: [first({ behaviour: 'quota', times: 1 })] });
    await runSim(sim);
    const [ev] = ofType(sim, 'fallback.taken');
    expect(ev.data).toMatchObject({ from: 'mock-openai', class: 'QUOTA', next_rung: true });
  });
  it('a stated quota reset is honoured', async () => {
    const reset = Date.UTC(2026, 0, 2);
    const sim = makeSim({
      script: [first({ behaviour: 'quota', args: { reset_at: reset }, times: 1 })],
    });
    await runSim(sim);
    expect(sim.engine.s.quarantine['mock-openai'].until).toBe(reset);
  });
  it('a failed attempt salvages its partial tree, and starts in a new directory', async () => {
    const sim = makeSim({
      script: [
        first({
          behaviour: 'crash_midway',
          edits: [{ path: 'src/t1/partial.txt', content: 'partial\n' }],
          times: 1,
        }),
      ],
    });
    await runSim(sim);
    const rec = ofType(sim, 'worktree.salvaged')[0];
    expect(sim.store.read(rec.data.path as string)).toContain('partial.txt');
    const paths = ofType(sim, 'worktree.created')
      .filter((e) => e.task_id === 'T1')
      .map((e) => e.data.path);
    expect(new Set(paths).size).toBe(2);
    const t1 = sim.engine.s.tasks.T1;
    expect(await sim.git.readFile(t1.commit as string, 'src/t1/partial.txt')).toBeNull();
  });
  it('a partial tree is never retained, and a failed rung is not an author', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'work', rung: 'mock-openai' }, behaviour: 'timeout' }],
    });
    await runSim(sim);
    expect(sim.engine.s.tasks.T1.retained_families).toEqual(['glm']);
    expect(sim.engine.s.tasks.T1.reviews[0].family).not.toBe('glm');
  });
  it("a timeout in repair 2 resets to repair 1's snapshot", async () => {
    const edits = (x: string) => [{ path: 'src/t1/a.txt', content: `${x}\n` }];
    const sim = makeSim({
      script: [
        first({ behaviour: 'ok', edits: edits('w') }),
        {
          match: { task: 'T1', step: 'review' },
          behaviour: 'reviewer_fail',
          times: 2,
          args: { findings: [{ subject: 'keeps failing', criterion: 'AC-1' }] },
        },
        { match: { task: 'T1', step: 'repair', attempt: 2 }, behaviour: 'ok', edits: edits('r1') },
        {
          match: { task: 'T1', step: 'repair', attempt: 3 },
          behaviour: 'timeout',
          edits: edits('partial'),
        },
        {
          match: { task: 'T1', step: 'repair' },
          behaviour: 'ok',
          edits: [{ path: 'src/t1/b.txt', content: 'b\n' }],
        },
      ],
    });
    await runSim(sim);
    const t1 = sim.engine.s.tasks.T1;
    const last = t1.snapshots[t1.snapshots.length - 1];
    expect(await sim.git.readFile(last.commit, 'src/t1/a.txt')).toBe('r1\n');
    expect(await sim.git.readFile(last.commit, 'src/t1/b.txt')).toBe('b\n');
  });
  it('a discarded repair by another family counts as an author only if retained', async () => {
    const sim = makeSim({
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
        { match: { task: 'T1', step: 'repair', rung: 'mock-openai' }, behaviour: 'quota' },
        { match: { task: 'T1', step: 'repair', rung: 'mock-glm' }, behaviour: 'timeout' },
      ],
    });
    await runSim(sim);
    const t1 = sim.engine.s.tasks.T1;
    expect(t1.retained_families).not.toContain('glm');
  });
  it('a second timeout on a second rung counts as a stall', async () => {
    const sim = makeSim({
      script: [
        first({ rung: 'mock-openai', behaviour: 'timeout' }),
        first({ rung: 'mock-glm', behaviour: 'timeout', times: 1 }),
      ],
    });
    await runSim(sim);
    expect(ofType(sim, 'stall.detected')[0].data.reason).toBe('second_timeout');
  });
  it('a term-ignoring worker that times out is handled', async () => {
    const sim = makeSim({ script: [first({ behaviour: 'hang_ignores_term', times: 1 })] });
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
  });
  it('all rungs failing pauses, and it resumes after the reset', async () => {
    const reset = Date.UTC(2026, 0, 1, 2);
    const script: any[] = [
      {
        match: { task: 'T1', step: 'work' },
        behaviour: 'quota',
        args: { reset_at: reset },
        times: 3,
      },
    ];
    const sim = makeSim({ script, plan: undefined });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_NO_WORKER');
    expect(exit.code).toBe(3);
    sim.clock.advance(reset - sim.clock.now() + 1);
    expect((await resumeSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
  });
});

describe('fallback at every other agent step', () => {
  const steps: [string, any, any][] = [
    ['plan', {}, {}],
    ['plan_review', { requested_depth: 'DEEP' }, {}],
    ['review', {}, { task: 'T1' }],
    ['acceptance', {}, {}],
    ['adversarial', { requested_depth: 'DEEP' }, {}],
  ];
  const classes = [
    'rate_limit',
    'quota',
    'auth',
    'outage',
    'unknown_failure',
    'timeout',
    'crash_midway',
    'malformed_report',
    'no_report',
  ];
  it.each(steps.flatMap(([s, spec, match]) => classes.map((c) => [s, c, spec, match] as const)))(
    '%s, %s: recovers with no repair charged',
    async (step, behaviour, spec, match) => {
      const sim = makeSim({
        spec,
        script: [{ match: { step: step as any, ...match }, behaviour: behaviour as any, times: 1 }],
      });
      const exit = await runSim(sim);
      expect(exit.state).toBe('MOCK_RUN_COMPLETE');
      for (const t of Object.values(sim.engine.s.tasks)) expect(t.repairs).toBe(0);
      expect(sim.engine.s.integrated_repairs).toBe(0);
    },
  );
  it('a read-only step with no rung left, at run level, pauses and reruns on resume', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'acceptance' }, behaviour: 'auth', times: 6 }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_NO_WORKER');
    expect(sim.engine.s.resume_to).toBe('VERIFYING');
  });
  it('a task review with no rung left: the task waits, and the run pauses', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'review', task: 'T1' }, behaviour: 'auth', times: 4 }],
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_NO_WORKER');
    expect(sim.engine.s.tasks.T1.state).toBe('TASK_WAITING_WORKER');
    expect(sim.engine.s.tasks.T1.next_step).toBe('review');
  });
  it('a pause must never drop a review, or mark a task passed', async () => {
    const sim = makeSim({
      script: [{ match: { step: 'review', task: 'T1' }, behaviour: 'auth', times: 4 }],
    });
    await runSim(sim);
    expect(sim.engine.s.tasks.T1.commit).toBeNull();
    expect(sim.engine.s.tasks.T1.reviews.length).toBe(0);
  });
});

describe('eligibility', () => {
  it.each(['not_installed', 'bad_version', 'missing_flag', 'auth_no', 'quota_exhausted'] as const)(
    'a rung reporting %s is skipped, with no call',
    async (probe) => {
      const sim = makeSim({ probes: { 'mock-openai': probe } });
      expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
      expect(sim.adapter.log.some((x) => x.rung === 'mock-openai')).toBe(false);
      expect(
        ofType(sim, 'eligibility.checked').some(
          (e) => e.data.rung === 'mock-openai' && e.data.ok === false,
        ),
      ).toBe(true);
    },
  );
  it('every planning rung out at the start pauses preflight', async () => {
    const probes: any = Object.fromEntries(
      [
        'mock-anthropic',
        'mock-openai',
        'mock-glm',
        'mock-anthropic-2',
        'mock-openai-2',
        'mock-glm-2',
      ].map((r) => [r, 'not_installed']),
    );
    const sim = makeSim({ probes });
    const exit = await runSim(sim);
    expect(exit.state).toBe('PAUSED_NO_WORKER');
    expect(sim.engine.s.resume_to).toBe('PREFLIGHT');
    for (const r of Object.keys(probes)) sim.adapter.setProbe(r, 'ok');
    expect((await resumeSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
  });
  it('a single-family configuration is refused', async () => {
    const sim = makeSim({
      policy: (p) => {
        for (const k of Object.keys(p.families.models)) p.families.models[k] = 'anthropic';
      },
    });
    expect((await runSim(sim)).state).toBe('FAILED');
    expect(sim.engine.s.reason).toContain('invalid policy');
  });
  it('an unexpected red baseline fails preflight; an expected one goes on', async () => {
    const sim = makeSim({ files: { 'README.md': 'x\n', '.sim/fail/full': 'Error: red\n' } });
    expect((await runSim(sim)).state).toBe('FAILED');
    const ok = makeSim({
      files: { 'README.md': 'x\n', '.sim/fail/full': 'Error: red\n' },
      spec: { expect_red_baseline: true },
    });
    expect((await runSim(ok)).state).toBe('MOCK_RUN_COMPLETE');
    expect(ok.engine.s.baseline_signature).toBeTruthy();
  });
  it('an unlisted control file fails preflight; a listed one is accepted', async () => {
    const sim = makeSim({ files: { 'README.md': 'x\n', 'AGENTS.md': 'do this\n' } });
    expect((await runSim(sim)).state).toBe('FAILED');
    const ok = makeSim({
      files: { 'README.md': 'x\n', 'AGENTS.md': 'do this\n' },
      spec: { known_control_files: ['AGENTS.md'] },
    });
    expect((await runSim(ok)).state).toBe('MOCK_RUN_COMPLETE');
  });
});
