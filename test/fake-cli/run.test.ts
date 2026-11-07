import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliEnv } from '../support/cli.ts';
import { fakeWorld } from '../support/fake-cli.ts';

describe('a production run on the pinned fixtures', () => {
  it('goes through the real relays, ends MOCK_RUN_COMPLETE and never publishes', () => {
    const c = cliEnv({ files: { 'README.md': 'x\n', 'src/a.txt': 'a\n' } });
    const w = fakeWorld();
    const r = c.run(['run', c.specPath, '--policy', resolve('policy'), '--run-id', 'r1'], w.env);
    const events = readFileSync(join(c.home, 'runs/r1/ledger/events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(r.stdout + r.stderr).toContain('MOCK_RUN_COMPLETE');
    const calls = readFileSync(join(w.home, 'fake-cli-calls.log'), 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThan(3);
    const reviews = events.filter((e) => e.type === 'review.collected');
    for (const e of reviews) expect(e.data.mock).toBe(true);
    expect(events.some((e) => e.type === 'push.intent')).toBe(false);
    expect(events.at(-1).type).not.toBe('publish.done');
  }, 180_000);
});
