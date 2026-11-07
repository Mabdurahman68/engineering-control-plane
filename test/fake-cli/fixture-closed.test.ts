import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const core = readFileSync('test/fake-cli/bin/fake-cli-core.mjs', 'utf8');

describe('the fixtures have a closed behaviour set', () => {
  it('launchers do nothing but start the core', () => {
    for (const name of ['codex', 'claude', 'opencode']) {
      expect(readFileSync(`test/fake-cli/bin/${name}`, 'utf8')).toBe(
        `#!/bin/sh\nexec node "$(dirname "$0")/fake-cli-core.mjs" ${name} "$@"\n`,
      );
    }
  });
  it('spawn only themselves, with a fixed argument shape', () => {
    expect(core.match(/\bspawn\(/g)).toHaveLength(1);
    expect(core).toMatch(/spawn\(process\.execPath, \[SELF, '--escape', flags\]/);
    expect(core).toContain("ESCAPES.includes(step.flags) ? step.flags : 'plain'");
  });
  it('have no other way to run anything', () => {
    for (const bad of [
      /(?<![.\w])exec(File)?(Sync)?\(/,
      /\bspawnSync\b/,
      /\bfork\(/,
      /\beval\(/,
      /new Function/,
      /\bimport\(/,
      /\brequire\(/,
      /node:(net|http|https|dns|tls|dgram|worker_threads|vm)/,
      /\bfetch\(/,
    ]) {
      expect(core).not.toMatch(bad);
    }
    const imports = [...core.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['node:child_process', 'node:fs', 'node:path', 'node:url']);
  });
  it('act from a fixed table of behaviours', () => {
    const cases = [...core.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]).sort();
    expect(cases).toEqual(
      [
        'auth',
        'escape',
        'escape_writers',
        'hang',
        'hang_writers',
        'ignore_term',
        'no_output',
        'outage',
        'quota',
        'rate_limit',
        'unknown',
      ].sort(),
    );
  });
});
