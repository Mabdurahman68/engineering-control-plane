import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/load.ts';
import { checkContractProbe } from '../../src/review/contract-probe.ts';
import { DelegateRelayAdapter } from '../../src/workers/relay/adapter.ts';
import { execCli } from '../../src/workers/relay/cli.ts';
import { fileSha } from '../../src/workers/relay/pins.ts';
import { reviewFail } from '../../src/workers/mock/mock-adapter.ts';
import { fakeRequest, fakeWorld } from '../support/fake-cli.ts';
import { makeRepo } from '../support/repo.ts';

const PIN = 'd857cfccf408e12d86b4a969c8c4544294919fe253a0096820ed9ed4d24fab5c';
const MODEL = 'gpt-6-astra';
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});
const fence = (o: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

const named = reviewFail(
  ['AC-1'],
  ['add.js'],
  [
    {
      criterion: 'AC-1',
      file: 'add.js',
      subject: 'wrong operator',
      observed: 'a - b',
      expected: 'a + b',
      message: 'it subtracts',
    },
  ],
  'add.js',
);

async function probe(step: any, login?: string) {
  const w = fakeWorld([step]);
  if (login) {
    writeFileSync(join(w.home, 'fake-cli-script.json'), JSON.stringify({ steps: [step], login }));
  }
  Object.assign(process.env, w.env);
  const repo = makeRepo({ 'add.js': 'export const add = (a, b) => a + b;\n' });
  writeFileSync(join(repo.dir, 'add.js'), 'export const add = (a, b) => a - b;\n');
  const tree = () =>
    execFileSync('git', ['status', '--porcelain'], { cwd: repo.dir, encoding: 'utf8' });
  const a = new DelegateRelayAdapter({
    id: 'codex-relay',
    kind: 'codex',
    repoRoot: resolve('.'),
    policy: loadPolicy(resolve('policy')),
  });
  const req = fakeRequest(repo.dir, {
    mode: 'read_only',
    model: MODEL,
    out_dir: join(w.home, 'out'),
    brief_path: join(w.home, 'brief.md'),
  });
  writeFileSync(req.brief_path, 'probe');
  const before = tree();
  const raw = await a.wait(await a.dispatch(req as never));
  return checkContractProbe({
    relayShaOk: fileSha(resolve('vendor/delegate-skills/codex-delegate/relay.mjs')) === PIN,
    status: raw.relay_status,
    finalMessage: raw.final_message,
    login: execCli(resolve('.'), 'codex', ['login', 'status'], { PATH: w.path, HOME: w.home })
      .stdout,
    requestedModel: MODEL,
    reportedModel: raw.model_reported,
    treeUnchanged: tree() === before,
  });
}

describe('the contract probe', () => {
  it('passes a consistent FAIL that names the planted defect', async () => {
    const r = await probe({ final: fence(named) });
    expect(r.failed).toEqual([]);
    expect(r.pass).toBe(true);
  }, 30_000);
  it.each([
    ['free text', { final: 'looks wrong to me' }, undefined],
    ['invalid JSON', { final: '```json\n{"verdict":\n```' }, undefined],
    [
      'PASS on the planted defect',
      { final: fence({ ...named, verdict: 'PASS', findings: [] }) },
      undefined,
    ],
    [
      'a FAIL naming something else',
      {
        final: fence({
          ...named,
          findings: [
            {
              ...named.findings[0],
              subject: 'naming',
              observed: 'style',
              expected: 'style',
              message: 'rename it',
            },
          ],
        }),
      },
      undefined,
    ],
    ['an API-key login', { final: fence(named) }, 'apikey'],
    ['no login', { final: fence(named) }, 'none'],
    ['a different model', { final: fence(named), reported_model: 'gpt-other' }, undefined],
    ['a failed run', { behaviour: 'quota' }, undefined],
  ])(
    'fails on %s',
    async (_n, step, login) => {
      const r = await probe(step, login as string | undefined);
      expect(r.pass).toBe(false);
      expect(r.failed.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
