import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
const importsOf = (file: string) => {
  const out: string[] = [];
  for (const m of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\()\s*'([^']+)'/g))
    if (m[1].startsWith('.')) out.push(resolve(dirname(file), m[1]));
  return out;
};

describe('wiring', () => {
  it('nothing under src imports from test', () => {
    const testDir = resolve('test');
    const bad = walk('src').flatMap((f) =>
      importsOf(f)
        .filter((d) => d.startsWith(testDir))
        .map((d) => `${f} -> ${d}`),
    );
    expect(bad).toEqual([]);
  });
  it('src/cli wires exactly two adapter kinds: the mock and the relay', () => {
    const text = readFileSync('src/cli/wire.ts', 'utf8');
    expect(text).toContain('adapters.mock = mock');
    expect(text).toContain('makeRelayAdapters(');
    const assigned = [...text.matchAll(/adapters\.(\w+) =/g)].map((m) => m[1]);
    expect(assigned).toEqual(['mock']);
    const adapters = walk('src')
      .filter((f) => /implements WorkerAdapter/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/\\/g, '/'));
    expect(adapters.sort()).toEqual(
      ['src/workers/mock/mock-adapter.ts', 'src/workers/relay/adapter.ts']
        .filter((f) => adapters.includes(f))
        .sort(),
    );
  });
  it('the test-only READY adapter is not reachable from src', () => {
    const bad = walk('src').filter((f) => readFileSync(f, 'utf8').includes('ready-adapter'));
    expect(bad).toEqual([]);
  });
  it('production code has no switch for turning a rule off', () => {
    const names = /(SKIP|DISABLE)_(GATE|REVIEW|RULE|CHECK|INDEPENDENCE)|ECP_(UNSAFE|SKIP|DISABLE)/;
    const bad = walk('src').filter((f) => names.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
