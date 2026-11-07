import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { wire } from '../../../src/cli/wire.ts';
import { loadPolicy } from '../../../src/policy/load.ts';
import { DelegateRelayAdapter } from '../../../src/workers/relay/adapter.ts';
import { fakeRequest, fakeWorld } from '../../support/fake-cli.ts';
import { testSpec } from '../../support/harness.ts';
import { makeRepo, tempDir } from '../../support/repo.ts';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});
class NotOwner extends Error {}
const notOwner = {
  assertOwner: () => {
    throw new NotOwner('not the owner');
  },
} as never;

describe('every coordinator write checks ownership first', () => {
  it('ledger appends, run-store writes, request deletion and notifications', () => {
    const home = tempDir('ecp-guard-');
    process.env.ECP_HOME = home;
    const repo = makeRepo({ 'README.md': 'x\n' });
    const spec = testSpec(repo.base, {
      target: { repo_path: repo.dir, base_commit: repo.base, repo_identity: repo.base },
    });
    const w = wire({
      runId: 'r1',
      spec,
      mockScript: { schema: 'mock_script.v1', steps: [] } as never,
      lock: notOwner,
    });
    const req = join(home, 'runs/r1/control/requests/1-1-a.json');
    mkdirSync(join(req, '..'), { recursive: true });
    writeFileSync(req, '{"id":"1-1-a","request":"cancel"}');
    expect(() => w.ledger.appendRaw('x\n')).toThrow(NotOwner);
    expect(() => w.store.write('a.txt', 'x')).toThrow(NotOwner);
    expect(() => w.engine.p.ackControl('1-1-a')).toThrow(NotOwner);
    expect(existsSync(req)).toBe(true);
    expect(() => w.engine.p.notify('test', 'x')).toThrow(NotOwner);
    expect(existsSync(join(home, 'notifications.jsonl'))).toBe(false);
    expect(existsSync(join(home, 'runs/r1/a.txt'))).toBe(false);
  });
  it('the relay adapter creates nothing under the run without it', async () => {
    const w = fakeWorld([{}]);
    Object.assign(process.env, w.env);
    const a = new DelegateRelayAdapter({
      id: 'codex-relay',
      kind: 'codex',
      repoRoot: resolve('.'),
      policy: loadPolicy(resolve('policy')),
      guard: () => {
        throw new NotOwner('not the owner');
      },
    });
    const dir = tempDir('ecp-guard-');
    const req = fakeRequest(dir, { out_dir: join(dir, 'fresh-attempt') });
    await expect(a.dispatch(req as never)).rejects.toThrow(NotOwner);
    expect(existsSync(join(dir, 'fresh-attempt'))).toBe(false);
  });
});
