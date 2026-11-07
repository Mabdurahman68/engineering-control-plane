import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../support/assert.ts';
import { events, makeSim, ofType, runSim } from '../support/harness.ts';

const RULE = 'R-C6-NO-ELIGIBILITY';
const onRung = (behaviour: string) => [
  { match: { step: 'shadow', rung: 'mock-glm' }, behaviour } as any,
];

describe.each(['shadow_quota', 'shadow_auth'])('%s on a rung', (behaviour) => {
  it('leaves worker eligibility, ladder and events unchanged, and the worker still goes there', async () => {
    const sim = makeSim({
      shadow: true,
      script: onRung(behaviour),
      policy: (p) => {
        // The shadow calls glm first; the worker's next dispatch also goes to glm.
        p.workers.ladders.shadow = ['mock-glm'];
        p.workers.ladders.implementation = ['mock-glm', 'mock-openai', 'mock-anthropic'];
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const unavailable = ofType(sim, 'shadow.unavailable').filter(
      (e) => e.data.class === (behaviour === 'shadow_quota' ? 'QUOTA' : 'AUTH'),
    );
    expect(unavailable.length).toBeGreaterThan(0);
    assertNotForbidden(
      RULE,
      Object.keys(sim.engine.s.quarantine).includes('mock-glm'),
      'a shadow signal quarantined a worker rung',
    );
    assertNotForbidden(
      RULE,
      Object.keys(sim.engine.s.backoff).includes('mock-glm'),
      'a shadow signal put a worker rung in backoff',
    );
    const later = sim.adapter.log.filter((x) => x.step === 'work');
    assertNotForbidden(
      RULE,
      later.some((x) => x.rung !== 'mock-glm'),
      'a worker moved off a rung because of the shadow',
    );
    const worker = events(sim).filter((e) =>
      ['fallback.taken', 'worker.quarantined', 'backoff.started', 'eligibility.checked'].includes(
        e.type,
      ),
    );
    assertNotForbidden(
      RULE,
      worker.some((e) => e.data.rung === 'mock-glm' && e.data.ok === false),
      'worker eligibility changed',
    );
    expect(worker.filter((e) => e.type !== 'eligibility.checked')).toEqual([]);
  });
  it('remembers it only for the shadow: it skips that rung next time', async () => {
    const sim = makeSim({
      shadow: true,
      script: onRung(behaviour),
      policy: (p) => {
        p.workers.ladders.shadow = ['mock-glm', 'mock-anthropic'];
      },
    });
    await runSim(sim);
    const calls = sim.adapter.log.filter((x) => x.step === 'shadow' && x.rung === 'mock-glm');
    expect(calls.length).toBeLessThanOrEqual(2);
  });
});

describe('worker state reaches the shadow, one way', () => {
  it('the shadow skips a rung the worker found limited', async () => {
    const sim = makeSim({
      shadow: true,
      script: [{ match: { task: 'T1', step: 'work', rung: 'mock-openai' }, behaviour: 'quota' }],
      policy: (p) => {
        p.workers.ladders.shadow = ['mock-openai', 'mock-anthropic', 'mock-glm'];
      },
    });
    await runSim(sim);
    const q = ofType(sim, 'worker.quarantined').find((e) => e.data.rung === 'mock-openai');
    expect(q).toBeTruthy();
    const allEvents = events(sim);
    const after = allEvents.filter((e) => e.seq > (q?.seq as number) && e.type === 'shadow.intent');
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((e) => e.data.rung !== 'mock-openai')).toBe(true);
  });
});
