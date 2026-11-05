import { describe, expect, it } from 'vitest';
import { planRecovery } from '../../src/core/recovery.ts';
import { SimulatedKill } from '../../src/core/ports.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { events, makeSim, resumeSim } from '../support/harness.ts';

const RULE = 'B2-ONE-RULE';
const base = {
  started: true,
  pid: 7,
  startTime: 'S',
  outDir: '/attempts/A',
  scan: [{ pid: 7, start_time: 'S', argv: 'relay --out-dir /attempts/A' }],
  alive: true,
  now: 100,
  deadlineMs: 1000,
};

describe('the one rule, as a decision', () => {
  it('re-attaches only to a proven live relay', () => {
    expect(planRecovery(base)).toBe('reattach');
  });
  it.each([
    ['no dispatch.started, relay alive', { started: false }],
    ['no recorded PID', { pid: null }],
    ['PID dead', { alive: false }],
    [
      'PID alive, different start time',
      { scan: [{ pid: 7, start_time: 'OTHER', argv: 'relay --out-dir /attempts/A' }] },
    ],
    [
      'PID alive, attempt directory not in argv',
      { scan: [{ pid: 7, start_time: 'S', argv: 'something else' }] },
    ],
    ['not in the scan', { scan: [] }],
    ['deadline passed', { now: 1000 + 60_000 }],
  ])('kills: %s', (_n, over) => {
    assertNotForbidden(
      RULE,
      planRecovery({ ...base, ...over } as any) === 'reattach',
      'an unproven relay was re-attached',
    );
  });
});

describe('the one rule, through the engine', () => {
  async function crashWhileWorking(
    after = 'after:dispatch.started#2',
    script: any[] = [
      { match: { task: 'T1', step: 'work' }, behaviour: 'ok', delay_ms: 50_000, times: 1 },
    ],
  ) {
    const sim = makeSim({ script });
    let armed = true;
    sim.failFn = (n) => {
      const isT1 = sim.adapter.log.at(-1)?.task === 'T1';
      if (armed && n === after && isT1) {
        armed = false;
        throw new SimulatedKill(n);
      }
    };
    sim.engine.createRun();
    await expect(sim.engine.loop()).rejects.toBeInstanceOf(SimulatedKill);
    sim.failFn = () => {};
    const signals: string[] = [];
    const kill = sim.ports.killer.kill;
    sim.ports.killer = {
      ...sim.ports.killer,
      kill: async (p, s) => {
        signals.push(s);
        return kill(p, s);
      },
    };
    return { sim, signals };
  }
  it('a relay proven live gets no signal, and its result is collected', async () => {
    const { sim, signals } = await crashWhileWorking();
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    assertNotForbidden(RULE, signals.length > 0, 'a live relay was signalled');
    expect(sim.engine.s.tasks.T1.snapshots.length).toBe(1);
    expect(sim.engine.s.tasks.T1.retained_families).toEqual(['openai']);
  });
  it('no dispatch.started, relay alive: killed, even though it looks healthy', async () => {
    const { sim, signals } = await crashWhileWorking('after_spawn_before_started');
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(signals).toContain('SIGTERM');
  });
  it('after a re-attached relay exits, the remainder is killed first', async () => {
    const { sim, signals } = await crashWhileWorking();
    const scan = sim.ports.scanner.scan;
    let children = 1;
    sim.ports.scanner = {
      ...sim.ports.scanner,
      scan: async (a) => {
        const found = await scan(a);
        const a2 = sim.engine.s.attempts[a.attempt_id];
        if (a2?.finished && children > 0) {
          return [...found, { pid: 99999, start_time: null, argv: 'child', cwd: a.cwd }];
        }
        return found;
      },
    };
    const kill = sim.ports.killer.kill;
    sim.ports.killer = {
      ...sim.ports.killer,
      kill: async (p, s) => {
        if (p.includes(99999)) children = 0;
        return kill(p, s);
      },
    };
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    expect(signals).toContain('SIGTERM');
    expect(children).toBe(0);
  });
  it('an expired re-attached relay is killed', async () => {
    const { sim, signals } = await crashWhileWorking('after:dispatch.started#2', [
      { match: { task: 'T1', step: 'work' }, behaviour: 'ok', delay_ms: 100_000_000, times: 1 },
    ]);
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    void signals;
    const cancels = events(sim).filter(
      (e) => e.type === 'cancel.sent' && e.data.reason === 'deadline',
    );
    expect(cancels.length).toBe(1);
  });
  it('a relay gone with no result is RELAY_LOST: salvaged, in a new directory', async () => {
    const { sim } = await crashWhileWorking();
    for (const rec of sim.git.survivors.values())
      rec.resolveNow({
        relay_status: null,
        exit_code: null,
        signal: 'SIGKILL',
        final_message: '',
        stderr_tail: '',
        session_id: null,
        model_reported: null,
        usage: null,
        result_present: false,
        transport_provenance: 'mock',
        cancelled_by_us: false,
      });
    const exit = await resumeSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const salvaged = sim.engine.s.tasks.T1;
    expect(salvaged.worktree_gen).toBe(2);
  });
});
