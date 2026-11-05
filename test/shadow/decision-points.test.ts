import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shadowProposalSchema } from '../../src/contracts/index.ts';
import { makeSim, ofType, runSim } from '../support/harness.ts';

const record = (sim: any, id: string) => JSON.parse(sim.store.read(`shadow/${id}.json`));

describe('every decision point', () => {
  const rich: any = {
    shadow: true,
    script: [
      { match: { task: 'T1', step: 'work' }, behaviour: 'quota', times: 1 },
      { match: { task: 'T2', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
      { match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 1 },
    ],
  };
  it('has a schema-valid proposal, or a recorded reason for none (AC-J)', async () => {
    const sim = makeSim(rich);
    await runSim(sim);
    const made = ofType(sim, 'decision.made');
    expect(made.length).toBeGreaterThan(5);
    const settled = new Set(
      [...ofType(sim, 'shadow.recorded'), ...ofType(sim, 'shadow.unavailable')].map(
        (e) => e.data.decision_id,
      ),
    );
    for (const d of made) {
      expect(settled.has(d.data.decision_id), String(d.data.decision_id)).toBe(true);
      const rec = record(sim, d.data.decision_id as string);
      expect(shadowProposalSchema.safeParse(rec).error).toBeUndefined();
      expect(rec.coordinator.action).toBe(d.data.action);
    }
    const points = new Set(made.map((d) => d.data.point));
    for (const p of ['DP-PLAN', 'DP-GATES', 'DP-REVIEW', 'DP-REPAIR', 'DP-FALLBACK', 'DP-VERIFY'])
      expect(points.has(p), p).toBe(true);
  });
  it('labels a mock shadow as mock', async () => {
    const sim = makeSim({ shadow: true });
    await runSim(sim);
    const id = ofType(sim, 'decision.made')[0].data.decision_id as string;
    expect(record(sim, id).shadow.mock).toBe(true);
  });
  it('compares by code: agreement, disagreement, and other always mismatches', async () => {
    const agree = makeSim({ shadow: true });
    await runSim(agree);
    expect(ofType(agree, 'shadow.recorded').every((e) => e.data.match === true)).toBe(true);
    const disagree = makeSim({
      shadow: true,
      script: [
        {
          match: { step: 'shadow' },
          behaviour: 'shadow_disagree',
          args: { action: 'abandon', reason: 'give up' },
        },
      ],
    });
    await runSim(disagree);
    expect(ofType(disagree, 'shadow.recorded').every((e) => e.data.match === false)).toBe(true);
    const other = makeSim({
      shadow: true,
      script: [{ match: { step: 'shadow' }, behaviour: 'shadow_other' }],
    });
    await runSim(other);
    expect(ofType(other, 'shadow.recorded').every((e) => e.data.match === false)).toBe(true);
  });
  it('marks a proposal that breaks the tables as illegal, and nothing else happens', async () => {
    const sim = makeSim({
      shadow: true,
      script: [
        {
          match: { step: 'shadow', point: 'DP-GATES' },
          behaviour: 'shadow_illegal',
          args: { action: 'accept_task' },
        },
      ],
    });
    await runSim(sim);
    const illegal = ofType(sim, 'shadow.recorded').filter(
      (e) => e.data.action === 'accept_task' && e.data.point === 'DP-GATES',
    );
    expect(illegal.length).toBeGreaterThan(0);
    expect(illegal.map((e) => [e.data.point, e.data.legal])).toEqual(
      illegal.map((e) => [e.data.point, false]),
    );
    const id = illegal[0].data.decision_id as string;
    expect(record(sim, id).comparison.would_violate.length).toBeGreaterThan(0);
    expect(sim.engine.s.state).toBe('MOCK_RUN_COMPLETE');
  });
});

describe('blind', () => {
  it('the bundle holds neither the coordinator choice nor earlier shadow output', async () => {
    const sim = makeSim({ shadow: true });
    await runSim(sim);
    const ids = ofType(sim, 'decision.made').map((e) => e.data.decision_id as string);
    for (const id of ids) {
      const bundle = sim.store.read(`shadow/${id}-input.json`) as string;
      expect(bundle, id).not.toContain('coordinator');
      expect(bundle, id).not.toContain('shadow');
      expect(bundle, id).not.toContain('transition');
      const parsed = JSON.parse(bundle);
      expect(parsed.action).toBeUndefined();
    }
  });
  it('runs in its own scratch directory, read-only', async () => {
    const sim = makeSim({ shadow: true });
    const seen: any[] = [];
    const d = sim.adapter.dispatch.bind(sim.adapter);
    sim.adapter.dispatch = (req) => {
      if (req.meta?.step === 'shadow') seen.push(req);
      return d(req);
    };
    await runSim(sim);
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.mode).toBe('read_only');
      expect(r.cwd).toContain('/sim/scratch/');
      expect(r.session_id).toBeNull();
    }
    expect(new Set(seen.map((r) => r.cwd)).size).toBe(seen.length);
  });
});

describe('the shadow rung', () => {
  it('prefers a family other than the code-writing one', async () => {
    const sim = makeSim({ shadow: true });
    const seen: any[] = [];
    const d = sim.adapter.dispatch.bind(sim.adapter);
    sim.adapter.dispatch = (req) => {
      if (req.meta?.step === 'shadow' && req.meta.task_id) seen.push(req);
      return d(req);
    };
    await runSim(sim);
    const gate = seen.filter((r) => r.meta.point === 'DP-GATES');
    expect(gate.length).toBeGreaterThan(0);
    for (const r of gate) expect(sim.engine.family(r.meta.rung)).not.toBe('openai');
  });
  it('falls back to the same family with a different model, and records that', async () => {
    const sim = makeSim({
      shadow: true,
      policy: (p) => {
        p.workers.ladders.shadow = ['mock-openai-2'];
      },
    });
    await runSim(sim);
    const rec = ofType(sim, 'decision.made')
      .map((d) => record(sim, d.data.decision_id as string))
      .find((r) => r.task_id && r.point === 'DP-GATES');
    expect(rec.shadow.family_relation).toBe('same_family_different_model');
    expect(rec.shadow.model_requested).toBe('mock-model-openai-2');
  });
  it('refuses the same model ID as the rung being judged', async () => {
    const sim = makeSim({
      shadow: true,
      policy: (p) => {
        p.workers.ladders.shadow = ['mock-openai'];
      },
    });
    await runSim(sim);
    const rec = ofType(sim, 'decision.made')
      .map((d) => record(sim, d.data.decision_id as string))
      .find((r) => r.task_id && r.point === 'DP-GATES');
    expect(rec.shadow.status).toBe('SHADOW_UNAVAILABLE');
  });
  it('a shadow cap records SHADOW_SKIPPED_BUDGET, and the run continues', async () => {
    const sim = makeSim({
      shadow: true,
      policy: (p) => {
        p.settings.caps.run.shadow_invocations = 2;
      },
    });
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    expect(sim.engine.s.shadow.invocations).toBe(2);
    expect(
      ofType(sim, 'shadow.unavailable').filter((e) => e.data.status === 'SHADOW_SKIPPED_BUDGET')
        .length,
    ).toBeGreaterThan(0);
    expect(sim.engine.s.shadow.skipped).toBeGreaterThan(0);
  });
  it('a slow shadow is waited on at the end for at most the limit, then marked unavailable', async () => {
    const sim = makeSim({
      shadow: true,
      script: [{ match: { step: 'shadow' }, behaviour: 'shadow_slow' }],
    });
    const t0 = sim.clock.now();
    expect((await runSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    const un = ofType(sim, 'shadow.unavailable');
    expect(un.length).toBeGreaterThan(0);
    expect(un.every((e) => ['END_OF_RUN', 'TIMEOUT'].includes(String(e.data.class)))).toBe(true);
    expect(sim.clock.now() - t0).toBeLessThanOrEqual(
      sim.policy.settings.timeouts.shadow_end_wait_s * 1000 + 1000,
    );
  });
  it('a crash with a shadow open: one re-dispatch from the frozen bundle, steering unaffected', async () => {
    const { SimulatedKill } = await import('../../src/core/ports.ts');
    const { resumeSim } = await import('../support/harness.ts');
    const sim = makeSim({ shadow: true });
    let armed = true;
    sim.failFn = (n) => {
      if (armed && n === 'after:shadow.intent') {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    expect((await resumeSim(sim)).state).toBe('MOCK_RUN_COMPLETE');
    const first = ofType(sim, 'shadow.intent')[0].data.decision_id;
    const forFirst = ofType(sim, 'shadow.intent').filter((e) => e.data.decision_id === first);
    expect(forFirst.length).toBe(2);
    expect(ofType(sim, 'shadow.recorded').some((e) => e.data.decision_id === first)).toBe(true);
  });
});

describe('no path from shadow to steering', () => {
  const importsOf = (file: string): string[] => {
    const text = readFileSync(file, 'utf8');
    const out: string[] = [];
    for (const m of text.matchAll(/(?:from\s+|import\()\s*'([^']+)'/g))
      if (m[1].startsWith('.')) out.push(resolve(dirname(file), m[1]));
    return out;
  };
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  it('src/core and src/policy cannot reach src/shadow, through any import', () => {
    const shadow = resolve('src/shadow');
    const roots = [...walk('src/core'), ...walk('src/policy')].map((p) => resolve(p));
    const seen = new Set<string>();
    const stack = [...roots];
    const bad: string[] = [];
    while (stack.length) {
      const f = stack.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const dep of importsOf(f)) {
        if (dep.startsWith(shadow)) bad.push(`${f} -> ${dep}`);
        else stack.push(dep);
      }
    }
    expect(bad).toEqual([]);
    expect(seen.size).toBeGreaterThan(10);
  });
  it('the reducer ignores shadow events when computing state', async () => {
    const sim = makeSim({ shadow: true });
    await runSim(sim);
    const plain = makeSim();
    await runSim(plain);
    const pick = (s: any) => ({
      state: s.state,
      tasks: Object.values(s.tasks).map((t: any) => t.state),
      risk: s.risk,
      depth: s.depth,
      repairs: s.counters.repairs,
      invocations: s.counters.invocations,
      quarantine: s.quarantine,
      backoff: s.backoff,
    });
    expect(pick(sim.engine.s)).toEqual(pick(plain.engine.s));
  });
});
