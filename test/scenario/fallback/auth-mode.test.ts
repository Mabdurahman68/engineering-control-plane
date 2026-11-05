import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../../support/assert.ts';
import { makeSim, runSim } from '../../support/harness.ts';

const RULE = 'AC-K';

// An API-key rung the owner configured, sitting next on the ladder.
const withKeyRung = (p: any) => {
  p.workers.rungs['mock-key'] = {
    adapter: 'mock',
    model: 'mock-model-glm-2',
    auth_mode: 'api_key',
    credential_env: ['FIXTURE_KEY'],
  };
  p.workers.ladders.implementation = ['mock-openai', 'mock-key'];
};

describe('a subscription rung failing', () => {
  it.each(['quota', 'auth'] as const)('on %s, never reaches an API-key rung', async (behaviour) => {
    const sim: any = makeSim({
      policy: withKeyRung,
      script: [{ match: { task: 'T1', step: 'work', rung: 'mock-openai' }, behaviour }],
    });
    await runSim(sim);
    const used = sim.adapter.log.filter((l: any) => l.rung === 'mock-key');
    assertNotForbidden(RULE, used.length > 0, `${behaviour} moved the work to an API key`);
    expect(sim.adapter.log.some((l: any) => l.rung === 'mock-openai')).toBe(true);
  });
  it('an API-key rung the owner put first is still theirs to use, until a subscription fails', async () => {
    const sim: any = makeSim({
      policy: (p: any) => {
        withKeyRung(p);
        p.workers.ladders.implementation = ['mock-key', 'mock-openai'];
      },
    });
    await runSim(sim);
    expect(sim.adapter.log.some((l: any) => l.rung === 'mock-key')).toBe(true);
  });
  it('a subscription rung is never handed a credential, whatever its configuration says', async () => {
    const sim: any = makeSim({
      policy: (p: any) => {
        p.workers.rungs['mock-openai'].credential_env = ['FIXTURE_KEY'];
      },
    });
    const seen: string[][] = [];
    const dispatch = sim.adapter.dispatch.bind(sim.adapter);
    sim.adapter.dispatch = (req: any) => {
      seen.push(req.env_allowlist);
      return dispatch(req);
    };
    await runSim(sim);
    expect(seen.length).toBeGreaterThan(0);
    assertNotForbidden(
      RULE,
      seen.some((e) => e.includes('FIXTURE_KEY')),
      'a subscription rung got a key',
    );
  });
});

describe('auth_mode', () => {
  it('is never written by any code path', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const writes = walk('src').filter((f) =>
      /auth_mode\s*(=[^=]|:\s*'api_key')|\[['"]auth_mode['"]\]\s*=/.test(readFileSync(f, 'utf8')),
    );
    assertNotForbidden(RULE, writes.length > 0, writes.join(', '));
  });
});
