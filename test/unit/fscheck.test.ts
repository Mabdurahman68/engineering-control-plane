import { realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFilesystem, type FsProbes } from '../../src/cli/fscheck.ts';
import { HomeRefused, prepareHome } from '../../src/cli/home.ts';
import { acquireLock } from '../../src/cli/lock.ts';
import { tempDir } from '../support/repo.ts';

const HEAD = 'Filesystem   512-blocks      Used Available Capacity  Mounted on';
const df = (mount: string) =>
  `${HEAD}\n/dev/disk3s5  965595304 330488464 579558288    37%    ${mount}\n`;
const line = (mount: string, opts: string) => `/dev/disk3s5 on ${mount} (${opts})`;
const probes = (o: {
  df?: string | null;
  mount?: string | null;
  types?: [number, number];
}): FsProbes => ({
  run: (cmd) => {
    const out = cmd === '/bin/df' ? o.df : o.mount;
    return out === null || out === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: out };
  },
  statfsType: (p) => (p === '/System/Volumes/Data' ? (o.types?.[1] ?? 26) : (o.types?.[0] ?? 26)),
});
const DATA = '/System/Volumes/Data';
const OK_MOUNT = `${line('/', 'apfs, sealed, local, read-only')}\n${line(DATA, 'apfs, local, journaled, nobrowse')}\n`;

describe('test 12: which filesystems the lock is trusted on', () => {
  it.each([
    ['apfs, local', df(DATA), OK_MOUNT, true],
    ['hfs, local', df(DATA), line(DATA, 'hfs, local, journaled'), true],
    ['smbfs', df(DATA), line(DATA, 'smbfs, nodev, nosuid'), false],
    ['nfs', df(DATA), line(DATA, 'nfs, nodev'), false],
    ['afpfs', df(DATA), line(DATA, 'afpfs, nodev'), false],
    ['webdav', df(DATA), line(DATA, 'webdav, nodev'), false],
    ['an unknown type', df(DATA), line(DATA, 'zfs, local'), false],
    ['apfs without local', df(DATA), line(DATA, 'apfs, journaled'), false],
    ['no matching mount', df(DATA), line('/other', 'apfs, local'), false],
    [
      'two matching mounts',
      df(DATA),
      `${line(DATA, 'apfs, local')}\n${line(DATA, 'apfs, local')}`,
      false,
    ],
    ['a prefix is not a match', df(DATA), line('/System/Volumes/Data/home', 'apfs, local'), false],
    [
      'a mount point with spaces',
      df('/Volumes/My Disk'),
      line('/Volumes/My Disk', 'apfs, local'),
      false,
    ],
    [
      'an escaped mount point',
      df('/Volumes/My\\040Disk'),
      line('/Volumes/My\\040Disk', 'apfs, local'),
      false,
    ],
    ['garbage from df', 'garbage', OK_MOUNT, false],
    ['garbage from mount', df(DATA), 'garbage', false],
    ['df failing', null, OK_MOUNT, false],
    ['mount failing', df(DATA), null, false],
  ])('%s', (_n, dfOut, mountOut, ok) => {
    expect(checkFilesystem('/x', probes({ df: dfOut, mount: mountOut })).ok).toBe(ok);
  });
  it('a statfs type that disagrees with the mount refuses', () => {
    expect(
      checkFilesystem('/x', probes({ df: df(DATA), mount: OK_MOUNT, types: [26, 17] })).ok,
    ).toBe(false);
  });
  it('this machine’s temporary directory passes, for real', () => {
    const r = checkFilesystem(tempDir('ecp-fs-'));
    expect(r).toMatchObject({ ok: true, type: 'apfs' });
  });
  it('a symlinked home is checked where it really lives', () => {
    const real = realpathSync(tempDir('ecp-real-'));
    const link = join(tempDir('ecp-link-'), 'home');
    symlinkSync(real, link);
    const seen: string[] = [];
    expect(() =>
      prepareHome({
        home: link,
        fscheck: (p) => {
          seen.push(p);
          return p.startsWith(real) || real.startsWith(p)
            ? { ok: false, reason: 'network' }
            : { ok: true, mount: '/', type: 'apfs' };
        },
      }),
    ).toThrow(HomeRefused);
    expect(seen.length).toBeGreaterThan(0);
  });
  it('a symlinked lock file is refused by the home check, and by the open itself', () => {
    const home = prepareHome({ home: join(tempDir('ecp-h-'), 'home') });
    const target = join(tempDir('ecp-t-'), 'elsewhere');
    symlinkSync(target, join(home, 'coordinator.lock'));
    expect(() => prepareHome({ home })).toThrow(/is a link/);
    const r = acquireLock(join(home, 'coordinator.lock'));
    expect(r.ok).toBe(false);
    expect(r.ok === false && !r.held).toBe(true);
  });
  it('anything but macOS refuses', () => {
    expect(() => prepareHome({ home: tempDir('ecp-p-'), platform: 'linux' })).toThrow(/macOS/);
    const r = acquireLock(join(tempDir('ecp-p-'), 'coordinator.lock'), { platform: 'linux' });
    expect(r.ok === false && !r.held && r.error).toMatch(/macOS/);
  });
});
