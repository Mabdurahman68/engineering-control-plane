import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../support/assert.ts';
import { events, makeSim, ofType, resumeSim, runSim } from '../support/harness.ts';

const RULE = 'R-LOCK-CONTROL';
const slow = [{ match: { task: 'T1', step: 'work' }, behaviour: 'ok', delay_ms: 50_000 }];

describe('requests arriving while a coordinator stops', () => {
  it('a cancel that arrives after a pause was acknowledged, while the pause completes, is applied', async () => {
    const sim: any = makeSim({ script: slow as never });
    let paused = false;
    let cancelled = false;
    sim.failFn = (n: string) => {
      if (n === 'after:dispatch.started' && !paused) {
        paused = true;
        sim.controls.push({ request: 'pause' });
      }
      // The pause is in the ledger; the cancel lands after that poll's snapshot was taken.
      if (n === 'after:operator.request_received' && !cancelled) {
        const last = events(sim).at(-1);
        if (last?.data.request === 'pause') {
          cancelled = true;
          sim.controls.push({ request: 'cancel' });
        }
      }
    };
    const exit = await runSim(sim);
    assertNotForbidden(
      RULE,
      exit.state !== 'CANCELLED',
      `stopped in ${exit.state} with a cancel left`,
    );
    expect(ofType(sim, 'operator.request_received').map((e: any) => e.data.request)).toEqual([
      'pause',
      'cancel',
    ]);
    expect(sim.controls).toEqual([]);
  });
  it('a pause, then a pause from a control command on the paused run: it stays paused', async () => {
    const sim: any = makeSim({ script: slow as never });
    let sent = false;
    sim.failFn = (n: string) => {
      if (n === 'after:dispatch.started' && !sent) {
        sent = true;
        sim.control = { request: 'pause' };
      }
    };
    expect((await runSim(sim)).state).toBe('PAUSED_OPERATOR');
    const dispatched = () =>
      events(sim).filter((e: any) =>
        ['dispatch.intent', 'plan.intent', 'review.intent'].includes(e.type),
      ).length;
    const before = dispatched();
    sim.control = { request: 'pause' };
    const again = await resumeSim(sim, { controlOnly: true });
    expect(again.state).toBe('PAUSED_OPERATOR');
    const acks = ofType(sim, 'operator.request_received');
    expect(acks.at(-1)?.data.effective).toBe(false);
    // Nothing ran: the second pause resumed no work.
    expect(dispatched()).toBe(before);
  });
  it('a cancel from a control command on the paused run is applied', async () => {
    const sim: any = makeSim({ script: slow as never });
    let sent = false;
    sim.failFn = (n: string) => {
      if (n === 'after:dispatch.started' && !sent) {
        sent = true;
        sim.control = { request: 'pause' };
      }
    };
    expect((await runSim(sim)).state).toBe('PAUSED_OPERATOR');
    sim.control = { request: 'cancel' };
    expect((await resumeSim(sim, { controlOnly: true })).state).toBe('CANCELLED');
  });
});

describe('a cancel at an escalation', () => {
  it('arriving as the run escalates, before its last look: applied, not just acknowledged', async () => {
    const sim: any = makeSim({
      script: [{ match: { step: 'acceptance' }, behaviour: 'reviewer_fail' }] as never,
    });
    let sent = false;
    sim.failFn = (n: string) => {
      if (
        n === 'after:run.state_changed' &&
        !sent &&
        sim.engine.s.state === 'ESCALATION_REQUIRED'
      ) {
        sent = true;
        sim.controls.push({ request: 'cancel' });
      }
    };
    const exit = await runSim(sim);
    expect(sent).toBe(true);
    assertNotForbidden(
      RULE,
      exit.state !== 'CANCELLED',
      `stopped in ${exit.state}, cancel acknowledged`,
    );
    expect(sim.engine.s.pending_request).toBeNull();
    expect(sim.controls).toEqual([]);
    const cancelled = ofType(sim, 'run.state_changed').filter(
      (e: any) => e.data.to === 'CANCELLED',
    );
    expect(cancelled).toHaveLength(1);
  });
});
