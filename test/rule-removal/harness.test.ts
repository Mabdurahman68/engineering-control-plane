import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_RULES } from './required-rules.ts';

function harness(args: string[]) {
  const results = join(mkdtempSync(join(tmpdir(), 'ecp-harness-')), 'results.json');
  const r = spawnSync(process.execPath, ['scripts/rule-removal.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ECP_RESULTS: results },
    timeout: 300_000,
  });
  return { ...r, output: `${r.stdout}${r.stderr}`, results };
}
const negative = (name: string) => [
  '--registry',
  `test/rule-removal/negative/${name}.yaml`,
  '--skip-completeness',
];

// The harness's own proof that it can say no. A harness that passes everything proves nothing.
describe('the rule-removal harness refuses', () => {
  it('a rule on the required list with no entry', () => {
    const r = harness(['--extra-required', 'NOT-A-RULE', '--rule', 'NOT-A-RULE']);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('unregistered rules: NOT-A-RULE');
  });
  it('a patch that does not compile: that is no detection', () => {
    const r = harness(negative('non-compiling'));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("doesn't compile");
    const out = JSON.parse(readFileSync(r.results, 'utf8'));
    expect(out.results[0].steps.typecheck).not.toBe(0);
    expect(out.results[0].steps.patched).toBeUndefined();
  }, 300_000);
  it('a patch that only renames a diagnostic: a failure with no token', () => {
    const r = harness(negative('mistargeted'));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('patch_not_targeted');
  }, 300_000);
  it('a patch that breaks a sibling', () => {
    const r = harness(negative('breaks-sibling'));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('a sibling broke');
  }, 300_000);
  it('a patch the test does not notice', () => {
    const r = harness(negative('no-effect'));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('survived');
  }, 300_000);
  it('a patch touching a file outside its list', () => {
    const r = harness(negative('outside-touches'));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('patch touches src/review/effective.ts');
    const out = JSON.parse(readFileSync(r.results, 'utf8'));
    expect(out.results[0].steps.typecheck).toBeUndefined();
  }, 300_000);
});

describe('the registry', () => {
  it('holds every required rule', () => {
    const text = readFileSync('test/rule-removal/registry.yaml', 'utf8');
    for (const id of REQUIRED_RULES) expect(text).toContain(`id: ${id}\n`);
  });
});
