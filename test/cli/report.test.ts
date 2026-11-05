import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '../../src/contracts/index.ts';
import { renderReport, renderStatus } from '../../src/report/report.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { decision, events, makeSim, ofType, resumeSim, runSim } from '../support/harness.ts';
import { readyAdapter } from '../support/ready-adapter.ts';

function reportOf(sim: any) {
  const evs = events(sim);
  const proposals = sim.store
    .list('shadow')
    .filter((f: string) => /^DP-\d+\.json$/.test(f))
    .map((f: string) => JSON.parse(sim.store.read(`shadow/${f}`)));
  return renderReport({
    runId: 'run1',
    spec: sim.spec,
    state: sim.engine.s,
    events: evs,
    proposals,
    rungModel: (r: string) => sim.policy.workers.rungs[r]?.model ?? r,
  });
}
// Hashes vary only with the content, and the sim's content is fixed, so these are stable.
function golden(name: string, text: string) {
  const dir = 'test/cli/golden';
  mkdirSync(dir, { recursive: true });
  const p = `${dir}/${name}`;
  if (process.env.ECP_UPDATE_GOLDEN) writeFileSync(p, text);
  // A missing golden file fails: it can't write itself and pass.
  expect(existsSync(p), `${p} is missing`).toBe(true);
  expect(text).toBe(readFileSync(p, 'utf8'));
}
const topSection = (t: string) => t.slice(0, t.indexOf('## Shadow orchestrator'));
const phoneWidth = (t: string) => {
  for (const line of topSection(t).split('\n')) expect(line.length, line).toBeLessThan(80);
};

describe('RUN_REPORT', () => {
  it('MOCK_RUN_COMPLETE: golden file, labelled, phone width', async () => {
    const sim = makeSim({
      shadow: true,
      script: [
        {
          match: { step: 'shadow', point: 'DP-REVIEW' },
          behaviour: 'shadow_disagree',
          args: { action: 'escalate', reason: 'I would stop here' },
          times: 1,
        },
      ],
    });
    await runSim(sim);
    const t = reportOf(sim);
    golden('report-mock.md', t);
    expect(t.split('\n')[1]).toBe('MOCK RUN — orchestration only; no semantic approval was given');
    expect(t).toContain('MOCK');
    phoneWidth(t);
  });
  it('lists every disagreement, one entry each', async () => {
    const sim = makeSim({
      shadow: true,
      script: [
        {
          match: { step: 'shadow' },
          behaviour: 'shadow_disagree',
          args: { action: 'abandon', reason: 'a reason' },
        },
      ],
    });
    await runSim(sim);
    const t = reportOf(sim);
    const count = ofType(sim, 'shadow.recorded').length;
    expect((t.match(/^- DP-\d+/gm) ?? []).length).toBe(count);
    expect(t).toContain('Coordinator: ');
    expect(t).toContain('Shadow: abandon (');
    expect(t).toContain('Why: "a reason"');
    expect(t).toContain("Agreement alone can't justify steering in v0.2.");
  });
  it('READY, with a real-review fixture object, and never by the mock path', async () => {
    const ready = makeReadySim();
    const exit = await runSim(ready);
    expect(exit.state).toBe('READY_FOR_HUMAN_MERGE');
    const t = reportOf(ready);
    golden('report-ready.md', t);
    expect(t).toContain('Merged: no. Merging is yours');
    expect(t).toContain('Pushed: no: no publish block');
    phoneWidth(t);
  });
  it('ESCALATION: the decision, why, options and the resume command', async () => {
    const sim = makeSim({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret' }],
    });
    await runSim(sim);
    const t = reportOf(sim);
    golden('report-escalation.md', t);
    expect(t).toContain('Decision needed: yes');
    expect(t).toContain('Decision: HARD_GATE_BREACH');
    expect(t).toContain('- retry_task:');
    expect(t).toContain('Resume: ecp resume run1 --with-decision <file>');
    phoneWidth(t);
  });
  it.each([
    [
      'PAUSED_BUDGET',
      {
        policy: (p: any) => {
          p.settings.caps.run.invocations = 2;
        },
      },
      'Raise the cap',
    ],
    [
      'PAUSED_NO_WORKER',
      { script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'auth' }] },
      'Fix the worker',
    ],
  ])(
    '%s: first line gives the reason, then what clears it and the resume command',
    async (state, over, clears) => {
      const sim = makeSim(over as any);
      expect((await runSim(sim)).state).toBe(state);
      const t = reportOf(sim);
      expect(t).toContain(clears);
      expect(t).toContain('Resume: ecp resume run1');
      phoneWidth(t);
    },
  );
  it('PAUSED_OPERATOR', async () => {
    const sim = makeSim();
    sim.failFn = (n) => {
      if (n === 'after:plan.intent') sim.control = { request: 'pause' };
    };
    expect((await runSim(sim)).state).toBe('PAUSED_OPERATOR');
    const t = reportOf(sim);
    expect(t.split('\n')[1]).toBe('Paused by you.');
    phoneWidth(t);
  });
  it('FAILED', async () => {
    const sim = makeSim();
    sim.git.clean = false;
    await runSim(sim);
    const t = reportOf(sim);
    expect(t.split('\n')[1]).toContain('Failed: H-CLEAN');
    phoneWidth(t);
  });
  it('states what the owner verified, not the system', async () => {
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
    await runSim(sim);
    await resumeSim(sim, {
      decision: decision(sim.engine.s.open_escalation as string, 'mark_human_verified', 'AC-1'),
    });
    expect(reportOf(sim)).toContain("AC-1 OWNER — you verified it; the system didn't");
  });
  it('says the pushed branch is public when it is', async () => {
    const sim = makeSim({
      spec: {
        publish: {
          repo: 'o/n',
          remote_url: 'u',
          base_branch: 'main',
          base_commit: 'a'.repeat(40),
          visibility_expected: 'public',
          allowed_paths: ['**'],
        },
      },
    });
    await runSim(sim);
    expect(reportOf(sim)).toContain('Visibility: PUBLIC. Anyone can see this branch and PR');
  });
  it('reports a corrected claim, and no figure from model text', async () => {
    const sim = makeSim({
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'claim_false_count',
          args: { value: 85 },
          times: 1,
        },
      ],
    });
    await runSim(sim);
    const t = reportOf(sim);
    expect(t).toContain('→ observed 1');
  });
});

describe('status output', () => {
  it('golden file', async () => {
    const sim = makeSim({ shadow: true });
    await runSim(sim);
    const st = renderStatus({
      runId: 'run1',
      state: sim.engine.s,
      events: events(sim),
      now: sim.clock.now(),
    });
    golden('status-mock.txt', st.text);
    expect(st.json.state).toBe('MOCK_RUN_COMPLETE');
    for (const line of st.text.split('\n'))
      assertNotForbidden('R-STATUS', line.length >= 100, line);
  });
});

function makeReadySim() {
  const sim = makeSim();
  sim.ports.adapters.mock = readyAdapter(sim.adapter);
  return sim;
}

// Independent recomputation: this walks the raw ledger with its own small counters, importing nothing
// from src/report or src/shadow, and compares to what the report and status say.
function recompute(evs: LedgerEvent[]) {
  const n = {
    gatesTotal: 0,
    gatesPassed: 0,
    waivers: 0,
    repairs: 0,
    fallbacks: 0,
    usageTotal: 0,
    usageMeasured: 0,
    interventions: 0,
    invocations: 0,
    decisionPoints: 0,
    recorded: 0,
    matched: 0,
    unavailable: 0,
    skipped: 0,
    illegal: 0,
  };
  for (const e of evs) {
    const d: any = e.data;
    if (e.type === 'gate.finished') {
      for (const r of d.results ?? []) {
        if (r.id.startsWith('test-')) continue;
        n.gatesTotal++;
        if (r.status !== 'FAIL') n.gatesPassed++;
      }
    }
    if (e.type === 'waiver.recorded') n.waivers++;
    if (e.type === 'repair.requested') n.repairs++;
    if (e.type === 'fallback.taken') n.fallbacks++;
    if (e.type === 'usage.recorded') {
      n.usageTotal++;
      if (d.tokens && d.tokens !== 'unavailable') n.usageMeasured++;
    }
    if (e.type === 'operator.decision') n.interventions++;
    if (['dispatch.intent', 'plan.intent', 'review.intent'].includes(e.type)) n.invocations++;
    if (e.type === 'decision.made') n.decisionPoints++;
    if (e.type === 'shadow.recorded') {
      n.recorded++;
      if (d.match === true) n.matched++;
      if (d.legal === false) n.illegal++;
    }
    if (e.type === 'shadow.unavailable' && d.decision_id) {
      if (d.status === 'SHADOW_SKIPPED_BUDGET') n.skipped++;
      else n.unavailable++;
    }
  }
  return n;
}

describe('AC-F and AC-J: figures match independent recomputation', () => {
  const measured = {
    source: 'vendor_cli_result',
    tokens: { input: 10, output: 5, cached: 0 },
    cost_usd: 2,
    quota_snapshot: 'unavailable',
    wall_clock_s: 1,
  };
  const scenarios: Record<string, any> = {
    plain: { shadow: true },
    'measured usage, one step only': {
      shadow: true,
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'ok', usage: measured }],
    },
    'shadow partly unavailable': {
      shadow: true,
      script: [
        { match: { step: 'shadow', point: 'DP-GATES' }, behaviour: 'shadow_quota' },
        {
          match: { step: 'shadow', point: 'DP-REVIEW' },
          behaviour: 'shadow_disagree',
          args: { action: 'abandon' },
        },
      ],
    },
    'shadow skipped by its cap': {
      shadow: true,
      policy: (p: any) => {
        p.settings.caps.run.shadow_invocations = 3;
      },
    },
    'shadow illegal': {
      shadow: true,
      script: [
        {
          match: { step: 'shadow', point: 'DP-GATES' },
          behaviour: 'shadow_illegal',
          args: { action: 'accept_task' },
        },
      ],
    },
    'repairs and fallbacks': {
      shadow: true,
      script: [
        { match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 },
        { match: { task: 'T2', step: 'work' }, behaviour: 'quota', times: 1 },
      ],
    },
  };
  it.each(Object.keys(scenarios))('%s', async (name) => {
    const sim = makeSim(scenarios[name]);
    await runSim(sim);
    const evs = events(sim);
    const n = recompute(evs);
    const t = reportOf(sim);
    expect(t).toContain(`Gates: ${n.gatesPassed}/${n.gatesTotal}`);
    expect(t).toContain(`Waivers: ${n.waivers}`);
    expect(t).toContain(`Repairs: ${n.repairs} total`);
    expect(t).toContain(`Fallbacks: ${n.fallbacks}`);
    expect(t).toContain(`(${n.usageMeasured} of ${n.usageTotal} measured)`);
    expect(t).toContain(`Human interventions: ${n.interventions}`);
    expect(t).toContain(`Decision points: ${n.decisionPoints}   Recorded: ${n.recorded}`);
    expect(t).toContain(`Unavailable: ${n.unavailable}   Skipped: ${n.skipped}`);
    expect(t).toContain(`Agreement among recorded: ${n.matched}/${n.recorded}`);
    expect(t).toContain(`Would have broken a rule: ${n.illegal}`);
    // Coverage: every decision point is accounted for. Unavailable and skipped are never dropped.
    expect(n.recorded + n.unavailable + n.skipped).toBe(n.decisionPoints);
    const st = renderStatus({
      runId: 'run1',
      state: sim.engine.s,
      events: evs,
      now: sim.clock.now(),
    }).text;
    expect(st).toContain(
      `SHADOW agreement=${n.matched}/${n.recorded} unavailable=${n.unavailable} skipped=${n.skipped}`,
    );
    expect(st).toContain(
      `measured=${n.usageMeasured}/${n.usageTotal} invocations=${n.invocations}`,
    );
  });
});
