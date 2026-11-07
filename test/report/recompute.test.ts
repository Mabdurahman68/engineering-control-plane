import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../support/assert.ts';
import { cliEnv } from '../support/cli.ts';

const RULE = 'AC-F';

// Its own small counting, from the raw JSONL. It imports nothing from src/report or src/shadow.
function count(home: string, run: string) {
  const lines = readFileSync(join(home, 'runs', run, 'ledger/events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const usage = lines.filter((e) => e.type === 'usage.recorded');
  const claims = new Map<string, any>();
  for (const e of lines)
    if (e.type === 'claim.recorded') claims.set(e.data.claim.claim_id, e.data.claim);
  const finals = [...claims.values()].map((c) => c.final);
  const tokens = usage
    .filter((u) => u.data.tokens && u.data.tokens !== 'unavailable')
    .map((u) => u.data.tokens.input + u.data.tokens.output);
  const costs = usage
    .filter((u) => typeof u.data.cost_usd === 'number')
    .map((u) => u.data.cost_usd);
  return {
    finished: lines.filter((e) => e.type === 'dispatch.finished').length,
    usageRecords: usage.length,
    tokens: tokens.reduce((a, b) => a + b, 0),
    tokenRuns: tokens.length,
    cost: costs.reduce((a, b) => a + b, 0),
    costRuns: costs.length,
    verified: finals.filter((f) => f === 'VERIFIED').length,
    corrected: finals.filter((f) => f === 'CORRECTED').length,
    rejected: finals.filter((f) => f === 'REJECTED').length,
    unverified: finals.filter((f) => f === 'UNVERIFIED').length,
  };
}

const measured = {
  source: 'vendor_cli_result',
  tokens: { input: 10, output: 5, cached: 0 },
  cost_usd: 2,
  quota_snapshot: 'unavailable',
  wall_clock_s: 1,
};
const report = (home: string, run: string) =>
  readFileSync(join(home, 'runs', run, 'RUN_REPORT.md'), 'utf8');

function compare(text: string, n: ReturnType<typeof count>) {
  const wants = [
    `Tokens: ${n.tokenRuns ? n.tokens : 'unavailable'} (${n.tokenRuns} of ${n.finished} measured)`,
    n.costRuns
      ? `${n.costRuns < n.finished ? 'at least ' : ''}$${n.cost.toFixed(2)}`
      : 'Cost: unavailable',
  ];
  for (const want of wants) {
    assertNotForbidden(RULE, !text.includes(want), `the report doesn't say: ${want}`);
  }
}

describe('report figures against the raw ledger', () => {
  it('partly measured usage is reported as partial, with the invocations as the denominator', () => {
    const c = cliEnv({
      script: [
        { match: { task: 'T1', step: 'work' }, behaviour: 'ok', usage: measured },
        { match: { task: 'T2', step: 'work' }, behaviour: 'ok', usage: measured },
      ],
    });
    c.run(c.startArgs('r1'));
    const n = count(c.home, 'r1');
    expect(n.costRuns).toBe(2);
    expect(n.finished).toBeGreaterThan(2);
    compare(report(c.home, 'r1'), n);
    // Status says the same: cost is partial, whatever the token coverage is.
    const st = JSON.parse(c.run(['status', 'r1', '--json']).stdout);
    assertNotForbidden(RULE, st.usage.cost !== n.cost, `status cost ${st.usage.cost} vs ${n.cost}`);
    assertNotForbidden(RULE, st.usage.cost_is_partial !== true, 'status hid a partial cost');
    expect(st.usage.cost_measured).toBe(`${n.costRuns}/${n.finished}`);
    expect(st.usage.measured).toBe(`${n.tokenRuns}/${n.finished}`);
    expect(st.usage.tokens).toBe(n.tokens);
    const text = c.run(['status', 'r1']).stdout;
    assertNotForbidden(
      RULE,
      !text.includes(`cost_measured=${n.costRuns}/${n.finished}`),
      'plain status hid a partial cost',
    );
  }, 120_000);
  it('claim figures take a claim once, at its latest state', () => {
    const c = cliEnv({
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'ok',
          report: {
            claims: [
              {
                claim: 'the code is tidy',
                type: 'FACT',
                value: null,
                verifier: { kind: 'file_exists', spec: { path: 'README.md' } },
              },
            ],
          },
        },
      ],
    });
    c.run(c.startArgs('r1'));
    const n = count(c.home, 'r1');
    const line = report(c.home, 'r1')
      .split('\n')
      .find((l) => l.startsWith('Claims'));
    assertNotForbidden(
      RULE,
      !line?.includes(
        `${n.verified} verified, ${n.corrected} corrected, ${n.rejected} rejected, ${n.unverified} unverified`,
      ),
      `${line} vs ${JSON.stringify(n)}`,
    );
    expect(n.unverified).toBeGreaterThan(0);
  }, 120_000);
  it('a crash between an invocation and its usage record loses nothing', () => {
    const c = cliEnv();
    const r = c.run(c.startArgs('r1'), { ECP_FAILPOINT: 'after:dispatch.finished@2' });
    expect(r.signal).toBe('SIGKILL');
    c.run(['resume', 'r1']);
    const n = count(c.home, 'r1');
    assertNotForbidden(RULE, n.usageRecords !== n.finished, `${n.usageRecords} of ${n.finished}`);
    compare(report(c.home, 'r1'), n);
  }, 120_000);
});
