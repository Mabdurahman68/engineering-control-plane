import { describe, expect, it } from 'vitest';
import { replay } from '../../../src/core/reducer.ts';
import { RUN_ROWS, RUN_TERMINAL, TASK_ROWS } from '../../../src/core/tables.ts';
import { Ledger, MemLedgerStore } from '../../../src/ledger/ledger.ts';

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

describe('random walks over the tables', () => {
  it('every legal walk replays to the same state, and ends only where a row allows', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const store = new MemLedgerStore();
      const l = new Ledger(store, 'r', () => '2026-01-01T00:00:00.000Z');
      const events = [
        l.append('run.created', null, {
          spec_id: 'S',
          spec_sha: 'x',
          policy_sha: 'y',
          risk: 'low',
          depth: 'QUICK',
        }),
      ];
      let state: string = 'CREATED';
      let taskState: string = 'PENDING';
      events.push(
        l.append('task.state_changed', 'T1', {
          from: null,
          to: 'PENDING',
          spec: {
            goal: 'g',
            lane: 'tests',
            allowed_paths: ['a'],
            forbidden_paths: [],
            acceptance_criteria: [],
            required_tests: [],
            depends_on: [],
          },
        }),
      );
      for (let i = 0; i < 40; i++) {
        const rows = RUN_ROWS.filter((x) => x.from === state);
        if (rows.length) {
          const row = rows[r() % rows.length];
          events.push(
            l.append('run.state_changed', null, {
              from: row.from,
              to: row.to,
              trigger: row.trigger,
            }),
          );
          state = row.to;
        }
        const tRows = TASK_ROWS.filter((x) => x.from === taskState);
        if (tRows.length) {
          const row = tRows[r() % tRows.length];
          events.push(
            l.append('task.state_changed', 'T1', {
              from: row.from,
              to: row.to,
              trigger: row.trigger,
            }),
          );
          taskState = row.to;
        }
      }
      const s = replay(events);
      expect(s.state).toBe(state);
      expect(s.tasks.T1.state).toBe(taskState);
      if (!RUN_ROWS.some((x) => x.from === state)) {
        expect(RUN_TERMINAL.includes(state as any)).toBe(true);
      }
    }
  });
});
