import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '../../../src/contracts/index.ts';
import { assertNotForbidden } from '../../support/assert.ts';
import { fuzzRun } from '../../support/fuzz-run.ts';
import { events, makeSim, runSim } from '../../support/harness.ts';

const RULE = 'AC-I';
const BEHAVIOURS = [
  'shadow_agree',
  'shadow_disagree',
  'shadow_illegal',
  'shadow_other',
  'shadow_malformed',
  'shadow_timeout',
  'shadow_quota',
  'shadow_auth',
  'shadow_slow',
  'shadow_crash',
  'shadow_predict',
];

// The steering record: everything but shadow events, envelope fields and timestamps.
function steering(evs: LedgerEvent[]) {
  return (
    evs
      .filter(
        (e) =>
          !e.type.startsWith('shadow.') &&
          e.type !== 'heartbeat' &&
          e.type !== 'host.sleep_detected',
      )
      // A process ID comes from the OS, and differs between any two runs. It's no part of steering.
      .map((e) => {
        const {
          pid: _p,
          start_time: _s,
          child_pid: _c,
          ...data
        } = e.data as Record<string, unknown>;
        return JSON.stringify([e.type, e.task_id, data]);
      })
  );
}
const firstDiff = (a: string[], b: string[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i])
      return `#${i}: ${String(a[i]).slice(0, 160)} vs ${String(b[i]).slice(0, 160)}`;
  return '';
};

const SCENARIOS: Record<string, any> = {
  happy: {},
  'review fail': {
    script: [{ match: { task: 'T1', step: 'review' }, behaviour: 'reviewer_fail', times: 1 }],
  },
  'worker quota': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'quota', times: 1 }],
  },
  'secret escalates': {
    script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret' }],
  },
  'acceptance fail': {
    script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail', times: 1 }],
  },
  'DEEP plan review': { spec: { requested_depth: 'DEEP' } },
};

describe.each(Object.keys(SCENARIOS))('logical steering invariance: %s', (name) => {
  it.each(BEHAVIOURS)('%s changes no steering event', async (behaviour) => {
    const over = SCENARIOS[name];
    const absent = makeSim(over);
    await runSim(absent);
    const withShadow = makeSim({
      ...over,
      shadow: true,
      script: [
        {
          match: { step: 'shadow' },
          behaviour,
          ...(behaviour === 'shadow_predict'
            ? {
                args: {
                  defect: {
                    kind: 'gate_failure',
                    horizon: 'next_gate',
                    gate_id: 'H-TESTS-PASS',
                    failing_test: null,
                    error_contains: null,
                  },
                },
              }
            : {}),
        },
        ...(over.script ?? []),
      ],
    });
    await runSim(withShadow);
    const a = steering(events(absent));
    const b = steering(events(withShadow));
    assertNotForbidden(RULE, JSON.stringify(a) !== JSON.stringify(b), firstDiff(a, b));
    expect(withShadow.engine.s.state).toBe(absent.engine.s.state);
    // The shadow actually ran, or this proves nothing.
    expect(withShadow.engine.s.shadow.decision_points).toBeGreaterThan(0);
    expect(withShadow.engine.s.shadow.invocations).toBeGreaterThan(0);
  });
});

describe('invariance across seeded runs, with every failure behaviour', () => {
  it('60 seeds, each against every shadow behaviour', async () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const base = await fuzzRun(seed, { noStops: true });
      const want = steering(events(base.sim));
      for (const behaviour of BEHAVIOURS) {
        const run = await fuzzRun(seed, { shadow: behaviour, noStops: true });
        const got = steering(events(run.sim));
        if (JSON.stringify(want) !== JSON.stringify(got))
          bad.push(`seed ${seed} ${behaviour}: ${firstDiff(want, got)}`);
      }
      if (bad.length > 4) break;
    }
    assertNotForbidden(RULE, bad.length > 0, bad.slice(0, 4).join(' || '));
  }, 900_000);
});
