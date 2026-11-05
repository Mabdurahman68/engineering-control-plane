import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/load.ts';
import {
  DelegateRelayAdapter,
  relayArgs,
  relayEnv,
  type CliKind,
} from '../../src/workers/relay/adapter.ts';
import { fakeRequest, fakeWorld } from '../support/fake-cli.ts';
import { tempDir } from '../support/repo.ts';

const policy = loadPolicy(resolve('policy'));
const KINDS: CliKind[] = ['codex', 'claude', 'opencode'];
const adapterFor = (kind: CliKind) =>
  new DelegateRelayAdapter({ id: `${kind}-relay`, kind, repoRoot: resolve('.'), policy });
const saved = { ...process.env };

function use(world: { env: Record<string, string> }) {
  Object.assign(process.env, world.env);
}
beforeEach(() => {
  process.env = { ...saved };
});
afterEach(() => {
  process.env = { ...saved };
});

async function runOnce(kind: CliKind, steps: any[], over: Record<string, unknown> = {}) {
  const w = fakeWorld(steps);
  use(w);
  const a = adapterFor(kind);
  const dir = tempDir('ecp-attempt-');
  const req = fakeRequest(dir, over);
  const h = await a.dispatch(req);
  const raw = await a.wait(h);
  return { w, a, raw, req, h };
}

describe.each(KINDS)('%s through its real relay', (kind) => {
  it('parses a completed result, marked as a fake transport by the adapter', async () => {
    const { raw, a } = await runOnce(kind, [
      { final: 'one\n\n```json\n{"a":1}\n```', session: 'S-1' },
    ]);
    expect(raw.relay_status).toBe('completed');
    expect(raw.final_message).toContain('"a":1');
    expect(raw.session_id).toBe('S-1');
    expect(raw.transport_provenance).toBe('fake_cli');
    expect(a.classify(raw)).toBe('OK');
  }, 30_000);

  it('reads usage from where this CLI reports it, and never invents it', async () => {
    const { raw, a } = await runOnce(kind, [{}]);
    const u = a.usage(raw);
    if (kind === 'codex') expect(u.tokens).toEqual({ input: 10, output: 5, cached: 1 });
    if (kind === 'claude') expect(u.cost_usd).toBe(0.01);
    if (kind === 'opencode') expect(u.tokens).toBe('unavailable');
  }, 30_000);

  it.each([
    ['quota', 'QUOTA'],
    ['auth', 'AUTH'],
    ['rate_limit', 'RATE_LIMIT'],
    ['outage', 'OUTAGE'],
    ['unknown', 'UNKNOWN'],
  ])(
    'classifies %s',
    async (behaviour, expected) => {
      const { raw, a } = await runOnce(kind, [{ behaviour }]);
      if (expected) expect(a.classify(raw)).toBe(expected);
      else expect(a.classify(raw)).not.toBe('OK');
    },
    30_000,
  );

  it('cancels a hanging worker, with the group gone', async () => {
    const w = fakeWorld([{ behaviour: 'hang' }]);
    use(w);
    const a = adapterFor(kind);
    const req = fakeRequest(tempDir('ecp-attempt-'));
    const h = await a.dispatch(req);
    await new Promise((r) => setTimeout(r, 1000));
    await a.cancel(h);
    const raw = await a.wait(h);
    expect(raw.cancelled_by_us).toBe(true);
    const log = readFileSync(join(w.home, 'fake-cli-calls.log'), 'utf8').trim().split('\n');
    const pid = JSON.parse(log[0] as string).pid;
    expect(() => process.kill(pid, 0)).toThrow();
  }, 40_000);

  it('collects a published result on re-attach and reports none otherwise', async () => {
    const { a, req } = await runOnce(kind, [{}]);
    const fresh = adapterFor(kind);
    const rec = {
      attempt_id: 'A-2',
      out_dir: req.out_dir,
      cwd: req.cwd,
      pid: null,
      start_time: null,
    };
    const h = await fresh.attach(rec);
    expect(h).not.toBe('gone');
    const raw = await fresh.wait(h as never);
    expect(raw.result_present).toBe(true);
    expect(raw.transport_provenance).toBe('fake_cli');
    rmSync(join(req.out_dir, 'result.json'));
    expect(await a.attach({ ...rec, attempt_id: 'A-3' })).toBe('gone');
  }, 30_000);

  it('never gives a CLI the API keys on a subscription rung', async () => {
    process.env.OPENAI_API_KEY = 'x';
    process.env.CODEX_API_KEY = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    const dir = tempDir('ecp-attempt-');
    const w = fakeWorld([{}]);
    use(w);
    const a = adapterFor(kind);
    await a.wait(await a.dispatch(fakeRequest(dir)));
    const line = JSON.parse(
      readFileSync(join(w.home, 'fake-cli-calls.log'), 'utf8').split('\n')[0] as string,
    );
    for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'])
      expect(line.env).not.toContain(k);
  }, 30_000);
});

describe('what a relay is given', () => {
  const FORBIDDEN = [
    '--lane',
    '--resume-last',
    '--continue-last',
    '--dangerously-skip-permissions',
    '--full-access',
    '--network-access',
    'danger-full-access',
  ];
  it('holds no forbidden flag for any configured rung and mode, and always the required ones', () => {
    for (const r of Object.values(policy.workers.rungs)) {
      for (const mode of ['write', 'read_only'] as const) {
        const kind = r.adapter.replace('-relay', '') as CliKind;
        const argv = relayArgs(
          kind,
          fakeRequest(tempDir('ecp-a-'), { mode, model: r.model }) as never,
          'relay.mjs',
        );
        for (const f of FORBIDDEN) expect(argv).not.toContain(f);
        for (const f of ['--model', '--timeout', '--out-dir']) expect(argv).toContain(f);
        if (mode === 'read_only') expect(argv).toContain('--read-only');
        if (kind === 'codex' && mode === 'read_only')
          expect(argv).toContain('--ignore-user-config');
      }
    }
  });
  it('passes opencode the effort as a variant, and nobody else', () => {
    const req = fakeRequest(tempDir('ecp-a-')) as never;
    expect(relayArgs('opencode', req, 'r')).toContain('--variant');
    expect(relayArgs('opencode', req, 'r')).not.toContain('--effort');
    expect(relayArgs('claude', req, 'r')).toContain('--effort');
  });
  it('builds the environment from an allowlist, and adds only named credentials', () => {
    const env = relayEnv({ PATH: 'p', HOME: 'h', OPENAI_API_KEY: 'k', SECRET: 's', MY_CRED: 'c' }, [
      'MY_CRED',
    ]);
    expect(env).toEqual({ PATH: 'p', HOME: 'h', MY_CRED: 'c' });
  });
});

describe('the pins', () => {
  it('refuses to dispatch when a vendored relay has changed', async () => {
    const root = tempDir('ecp-root-');
    writeFileSync(join(root, 'x'), '');
    const a = new DelegateRelayAdapter({
      id: 'codex-relay',
      kind: 'codex',
      repoRoot: root,
      policy,
    });
    await expect(a.dispatch(fakeRequest(root) as never)).rejects.toThrow();
  });
});
