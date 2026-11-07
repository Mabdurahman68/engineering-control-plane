import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProcControl,
  ProcControlBlocked,
  validProcArgs,
  writerCap,
} from '../../src/isolation/ecp-proc.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { tempDir } from '../support/repo.ts';

const RULE = 'B2-PROCCTL';

function fakeHelper(count: string, code = 0) {
  const dir = tempDir('ecp-proc-');
  const log = join(dir, 'calls');
  const path = join(dir, 'ecp-proc');
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${log}"\nprintf '%s' '${count}'\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

describe('the process-control helper, as a fake', () => {
  it('calls kill-all before a re-dispatch, and a zero count lets it go on', () => {
    const h = fakeHelper('0');
    new ProcControl(h.path).beforeRedispatch('A-1');
    expect(readFileSync(h.log, 'utf8').trim()).toBe('kill-all A-1');
  });
  it.each([
    ['a non-zero count', '2', 0],
    ['no count', '', 0],
    ['a count that is not a number', 'lots', 0],
    ['a helper failure', '0', 1],
  ])('blocks on %s', (_n, count, code) => {
    const h = fakeHelper(count as string, code as number);
    let blocked = false;
    try {
      new ProcControl(h.path).beforeRedispatch('A-1');
    } catch (err) {
      blocked = err instanceof ProcControlBlocked;
    }
    assertNotForbidden(RULE, !blocked, 'continued with processes possibly alive');
  });
  it('passes only the allowed commands and a validated attempt ID', () => {
    for (const c of ['scan', 'spawn', 'kill-all']) expect(validProcArgs(c, 'A-1')).toBe(true);
    for (const [c, id] of [
      ['rm', 'A-1'],
      ['kill-all --user=root', 'A-1'],
      ['scan', '../etc'],
      ['scan', 'A 1'],
      ['scan', '-rf'],
      ['scan', ''],
      ['scan', 'A;id'],
      ['scan', 'A'.repeat(65)],
    ] as const) {
      assertNotForbidden(RULE, validProcArgs(c, id), `${c} ${id}`);
    }
  });
  it('never reaches the helper with a bad argument', () => {
    const h = fakeHelper('0');
    expect(() => new ProcControl(h.path).scan('../x')).toThrow(/refused/);
    expect(existsSync(h.log)).toBe(false);
  });
  it('caps writers at one per worker user once a real rung is configured', () => {
    assertNotForbidden(
      RULE,
      writerCap({ configured: 3, realRung: true }) !== 1,
      'more than one writer',
    );
    expect(writerCap({ configured: 3, realRung: false })).toBe(3);
  });
});
