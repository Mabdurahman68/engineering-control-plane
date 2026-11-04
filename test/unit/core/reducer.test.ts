import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '../../../src/contracts/index.ts';
import { RUN_STATES, TASK_STATES } from '../../../src/contracts/index.ts';
import {
  applyInPlace,
  initialRun,
  InvariantViolation,
  reduce,
  replay,
} from '../../../src/core/reducer.ts';
import {
  LEGAL_RUN_PAIRS,
  LEGAL_TASK_PAIRS,
  RUN_ROWS,
  RUN_TERMINAL,
  TASK_ROWS,
  TASK_TERMINAL,
} from '../../../src/core/tables.ts';
import { Ledger, MemLedgerStore } from '../../../src/ledger/ledger.ts';

function ev(type: LedgerEvent['type'], data: any, task_id: string | null = null): LedgerEvent {
  return {
    schema: 'event.v1',
    seq: 0,
    at: '2026-01-01T00:00:00.000Z',
    run_id: 'r',
    task_id,
    type,
    data,
    prev: '',
    hash: 'x',
  };
}
const SPEC = {
  goal: 'g',
  lane: 'implementation',
  allowed_paths: ['**'],
  forbidden_paths: [],
  acceptance_criteria: [],
  required_tests: [],
  depends_on: [],
};

describe('run transitions', () => {
  it.each(RUN_STATES.flatMap((f) => RUN_STATES.map((t) => [f, t] as const)))(
    'pair %s -> %s is legal or throws',
    (from, to) => {
      const s = initialRun();
      s.state = from;
      const rows = RUN_ROWS.filter((r) => r.from === from && r.to === to);
      if (LEGAL_RUN_PAIRS.has(`${from}>${to}`)) {
        for (const r of rows) {
          const n = reduce(s, ev('run.state_changed', { from, to, trigger: r.trigger }));
          expect(n.state).toBe(to);
        }
      } else {
        expect(rows.length).toBe(0);
        expect(() => reduce(s, ev('run.state_changed', { from, to, trigger: 'anything' }))).toThrow(
          InvariantViolation,
        );
      }
    },
  );
  it('rejects a legal pair under the wrong trigger', () => {
    const s = initialRun();
    expect(() =>
      reduce(s, ev('run.state_changed', { from: 'CREATED', to: 'PREFLIGHT', trigger: 'nope' })),
    ).toThrow(InvariantViolation);
  });
  it('rejects a transition from a state the run is not in', () => {
    const s = initialRun();
    expect(() =>
      reduce(
        s,
        ev('run.state_changed', { from: 'PLANNING', to: 'EXECUTING', trigger: 'plan_valid' }),
      ),
    ).toThrow(InvariantViolation);
  });
  it('gives every non-terminal state an exit', () => {
    for (const s of RUN_STATES) {
      if (RUN_TERMINAL.includes(s)) continue;
      expect(
        RUN_ROWS.some((r) => r.from === s),
        s,
      ).toBe(true);
    }
  });
  it('gives terminal states no exit', () => {
    for (const s of RUN_TERMINAL)
      expect(
        RUN_ROWS.some((r) => r.from === s),
        s,
      ).toBe(false);
  });
  it('reaches every state from CREATED', () => {
    const seen = new Set<string>(['CREATED']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of RUN_ROWS) {
        if (seen.has(r.from) && !seen.has(r.to)) {
          seen.add(r.to);
          grew = true;
        }
      }
    }
    for (const s of RUN_STATES) expect(seen.has(s), s).toBe(true);
  });
  it('never resumes a paused run into another paused state', () => {
    const paused = ['PAUSED_NO_WORKER', 'PAUSED_BUDGET', 'PAUSED_OPERATOR'];
    for (const r of RUN_ROWS) {
      if (paused.includes(r.from) && r.trigger === 'resume') {
        expect(paused.includes(r.to)).toBe(false);
      }
    }
  });
});

describe('task transitions', () => {
  it.each(TASK_STATES.flatMap((f) => TASK_STATES.map((t) => [f, t] as const)))(
    'pair %s -> %s is legal or throws',
    (from, to) => {
      const open = reduce(
        initialRun(),
        ev('task.state_changed', { from: null, to: from, spec: SPEC }, 'T1'),
      );
      const rows = TASK_ROWS.filter((r) => r.from === from && r.to === to);
      if (LEGAL_TASK_PAIRS.has(`${from}>${to}`)) {
        for (const r of rows) {
          const n = reduce(open, ev('task.state_changed', { from, to, trigger: r.trigger }, 'T1'));
          expect(n.tasks.T1.state).toBe(to);
        }
      } else {
        expect(() =>
          reduce(open, ev('task.state_changed', { from, to, trigger: 'anything' }, 'T1')),
        ).toThrow(InvariantViolation);
      }
    },
  );
  it('gives every non-terminal state an exit', () => {
    for (const s of TASK_STATES) {
      if (TASK_TERMINAL.includes(s)) continue;
      expect(
        TASK_ROWS.some((r) => r.from === s),
        s,
      ).toBe(true);
    }
  });
  it('reaches every state from PENDING', () => {
    const seen = new Set<string>(['PENDING']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of TASK_ROWS) {
        if (seen.has(r.from) && !seen.has(r.to)) {
          seen.add(r.to);
          grew = true;
        }
      }
    }
    for (const s of TASK_STATES) expect(seen.has(s), s).toBe(true);
  });
  it('rejects a task opened twice', () => {
    const open = reduce(
      initialRun(),
      ev('task.state_changed', { from: null, to: 'PENDING', spec: SPEC }, 'T1'),
    );
    expect(() =>
      reduce(open, ev('task.state_changed', { from: null, to: 'PENDING', spec: SPEC }, 'T1')),
    ).toThrow(InvariantViolation);
  });
});

describe('replay', () => {
  function sequence() {
    const store = new MemLedgerStore();
    const l = new Ledger(store, 'r', () => '2026-01-01T00:00:00.000Z');
    const out: LedgerEvent[] = [];
    out.push(
      l.append('run.created', null, {
        spec_id: 'S',
        spec_sha: 'x',
        policy_sha: 'y',
        risk: 'low',
        depth: 'QUICK',
      }),
    );
    out.push(
      l.append('run.state_changed', null, {
        from: 'CREATED',
        to: 'PREFLIGHT',
        trigger: 'lock_acquired',
      }),
    );
    out.push(l.append('task.state_changed', 'T1', { from: null, to: 'PENDING', spec: SPEC }));
    out.push(
      l.append('task.state_changed', 'T1', {
        from: 'PENDING',
        to: 'READY',
        trigger: 'deps_passed',
      }),
    );
    return out;
  }
  it('is deterministic', () => {
    const e = sequence();
    expect(replay(e)).toEqual(replay(e));
    expect(replay(e).state).toBe('PREFLIGHT');
    expect(replay(e).tasks.T1.state).toBe('READY');
  });
  it('reduce equals the in-place form', () => {
    const e = sequence();
    let a = initialRun();
    const b = initialRun();
    for (const x of e) {
      a = reduce(a, x);
      applyInPlace(b, x);
    }
    expect(a).toEqual(b);
  });
  it('ignores shadow events when computing steering state', () => {
    const e = sequence();
    const withShadow = [
      ...e,
      ev('shadow.intent', { decision_id: 'DP-1' }),
      ev('shadow.recorded', { decision_id: 'DP-1', match: false, action: 'escalate' }),
      ev('shadow.unavailable', { decision_id: 'DP-2', status: 'SHADOW_UNAVAILABLE' }),
      ev('shadow.outcome_resolved', { decision_id: 'DP-1' }),
    ];
    const a: any = replay(e);
    const b: any = replay(withShadow);
    a.shadow = b.shadow = null;
    a.counters.shadow_invocations = b.counters.shadow_invocations = 0;
    expect(b).toEqual(a);
  });
});
