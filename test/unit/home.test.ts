import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HomeRefused, prepareHome } from '../../src/cli/home.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { holder } from '../support/lock-procs.ts';
import { tempDir } from '../support/repo.ts';

const RULE = 'R-LOCK-HOME';
const refused = (home: string) => {
  try {
    prepareHome({ home });
    return false;
  } catch (err) {
    return err instanceof HomeRefused;
  }
};
const listing = (d: string) => (existsSync(d) ? readdirSync(d).sort() : null);

describe('test 13: what a home may already hold', () => {
  it('an empty directory becomes a v2 home', () => {
    const home = tempDir('ecp-h-');
    expect(prepareHome({ home })).toBeTruthy();
    expect(readFileSync(join(home, 'layout'), 'utf8')).toBe('ecp-home v2');
    expect(listing(home)).toEqual(['layout', 'runs']);
  });
  it('a v2 home is accepted again', () => {
    const home = tempDir('ecp-h-');
    prepareHome({ home });
    expect(() => prepareHome({ home })).not.toThrow();
  });
  it.each([
    ['an older version’s run.lock', (h: string) => writeFileSync(join(h, 'run.lock'), '')],
    ['runs/ without a layout', (h: string) => mkdirSync(join(h, 'runs'))],
    ['another layout', (h: string) => writeFileSync(join(h, 'layout'), 'ecp-home v3')],
    ['a stray file', (h: string) => writeFileSync(join(h, 'notes.txt'), 'x')],
  ])('%s is refused, before anything is created', (_n, make) => {
    const home = tempDir('ecp-h-');
    make(home);
    const before = listing(home);
    assertNotForbidden(RULE, !refused(home), 'a home from another version was accepted');
    expect(listing(home)).toEqual(before);
  });
  it('a v2 home that later gained an older version’s run.lock is refused', () => {
    const home = tempDir('ecp-h-');
    prepareHome({ home });
    writeFileSync(join(home, 'run.lock'), '');
    assertNotForbidden(RULE, !refused(home), 'a legacy lock was ignored');
  });
});

describe('test 16: a home that does not exist yet', () => {
  it('is created, validated and given a layout', () => {
    const home = join(tempDir('ecp-h-'), 'a', 'b', 'home');
    prepareHome({ home });
    expect(readFileSync(join(home, 'layout'), 'utf8')).toBe('ecp-home v2');
  });
  it('under an ancestor on a network or unknown filesystem, is refused before anything is created', () => {
    const parent = tempDir('ecp-h-');
    const home = join(parent, 'a', 'home');
    expect(() =>
      prepareHome({ home, fscheck: () => ({ ok: false, reason: 'smbfs is not supported' }) }),
    ).toThrow(HomeRefused);
    expect(listing(parent)).toEqual([]);
  });
});

describe('test 17: an interrupted or concurrent first start', () => {
  it('a leftover tmp file and no layout: published now, and the leftover removed', () => {
    const home = tempDir('ecp-h-');
    writeFileSync(join(home, 'layout.tmp-1-abc'), 'ecp-ho');
    prepareHome({ home });
    expect(listing(home)).toEqual(['layout', 'runs']);
  });
  it('a layout with the wrong contents refuses', () => {
    const home = tempDir('ecp-h-');
    writeFileSync(join(home, 'layout'), 'ecp-ho');
    expect(refused(home)).toBe(true);
  });
  it('two processes starting one home together: one valid layout, never half a home', async () => {
    for (let round = 0; round < 5; round++) {
      const home = join(tempDir('ecp-h-'), 'home');
      const hs = [holder(home), holder(home)];
      await Promise.all(hs.map((h) => h.ready));
      const answers = await Promise.all(hs.map((h) => h.ask('acquire')));
      expect(answers.every((a) => a.error === null)).toBe(true);
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      expect(readFileSync(join(home, 'layout'), 'utf8')).toBe('ecp-home v2');
      for (const h of hs) h.child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('test 17, the link race forced', () => {
  it('another start publishes layout and clears this tmp just before this link: accepted, one layout', () => {
    const home = tempDir('ecp-h-');
    prepareHome({
      home,
      beforeLink: (tmp) => {
        writeFileSync(join(home, 'layout'), 'ecp-home v2');
        rmSync(tmp);
      },
    });
    expect(readFileSync(join(home, 'layout'), 'utf8')).toBe('ecp-home v2');
    expect(listing(home)).toEqual(['layout', 'runs']);
  });
  it('the same, but the other start left a bad layout: refused', () => {
    const home = tempDir('ecp-h-');
    expect(() =>
      prepareHome({
        home,
        beforeLink: (tmp) => {
          writeFileSync(join(home, 'layout'), 'ecp-ho');
          rmSync(tmp);
        },
      }),
    ).toThrow(HomeRefused);
  });
});

describe('test 17, a start that looks while another publishes', () => {
  it('a home holding a published layout and runs/, and nothing else, is this version’s', () => {
    const home = tempDir('ecp-h-');
    writeFileSync(join(home, 'layout'), 'ecp-home v2');
    mkdirSync(join(home, 'runs'));
    writeFileSync(join(home, 'layout.tmp-9-abc'), 'ecp-home v2');
    expect(() => prepareHome({ home })).not.toThrow();
    expect(listing(home)).toEqual(['layout', 'runs']);
  });
  it('many starts on one fresh home, round after round: no start refuses', async () => {
    for (let round = 0; round < 10; round++) {
      const home = join(tempDir('ecp-h-'), 'home');
      const hs = Array.from({ length: 6 }, () => holder(home));
      await Promise.all(hs.map((h) => h.ready));
      const answers = await Promise.all(hs.map((h) => h.ask('acquire')));
      expect(answers.filter((a) => a.error)).toEqual([]);
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      for (const h of hs) h.child.kill('SIGKILL');
    }
  }, 120_000);
});
