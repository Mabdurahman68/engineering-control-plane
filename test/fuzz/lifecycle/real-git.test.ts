import { describe, expect, it } from 'vitest';
import { RUN_STOPPING } from '../../../src/core/tables.ts';
import { loadLedger } from '../../../src/ledger/ledger.ts';
import { makeReal, runReal } from '../../support/harness.ts';

// Coverage on real git and real files. It isn't proof that the two drivers are equivalent.
const WORK = [
  'ok',
  'ok',
  'malformed_report',
  'quota',
  'auth',
  'crash_midway',
  'edit_out_of_scope',
  'edit_control_file',
  'commit_head',
  'write_secret',
  'claim_false_count',
  'no_change',
];
const REVIEW = [
  'reviewer_pass',
  'reviewer_pass',
  'reviewer_fail',
  'reviewer_inconsistent',
  'reviewer_modifies_tree',
  'reviewer_incomplete',
  'quota',
];

function rng(seed: number) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

async function one(seed: number): Promise<string | null> {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const script: any[] = [];
  for (let i = 0; i < 6; i++) {
    const review = r() < 0.5;
    const step = review ? pick(['review', 'acceptance']) : pick(['work', 'repair']);
    script.push({ match: { step }, behaviour: pick(review ? REVIEW : WORK), times: 1 });
  }
  const sim = makeReal({ script });
  const exit = await runReal(sim);
  const bad = loadLedger(sim.ledger).events.filter((e) => e.type === 'invariant.violation');
  if (bad.length) return `seed ${seed}: ${JSON.stringify(bad[0].data).slice(0, 300)}`;
  if (!RUN_STOPPING.includes(exit.state)) return `seed ${seed}: ended in ${exit.state}`;
  if (exit.state === 'READY_FOR_HUMAN_MERGE') return `seed ${seed}: mock review reached READY`;
  return null;
}

const RUNS = Number(process.env.ECP_FUZZ_REAL_RUNS ?? 200);

describe('the hole test on real git', () => {
  it(`${RUNS} seeded runs end in a terminal or decision state`, async () => {
    const bad: string[] = [];
    let next = 1;
    const worker = async () => {
      while (next <= RUNS) {
        const seed = next++;
        const out = await one(seed);
        if (out) bad.push(out);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    expect(bad.slice(0, 6)).toEqual([]);
  }, 1_200_000);
});
