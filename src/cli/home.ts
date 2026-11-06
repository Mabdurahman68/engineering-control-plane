import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { checkFilesystem, type FsCheck } from './fscheck.ts';

// The home moved to home-v2, so this version and anything at or before f98083b never share files: the
// old one uses ~/.ecp/run.lock and ~/.ecp/runs, which this never reads or writes. Precondition: don't
// point an old executable's ECP_HOME at a v2 home. Code can't enforce that against older code.
export const LAYOUT = 'ecp-home v2';

export function homePath(): string {
  return process.env.ECP_HOME ?? join(homedir(), '.ecp', 'home-v2');
}

export class HomeRefused extends Error {}

const isLeftover = (name: string) => name.startsWith('layout.tmp-');

function readLayout(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export type HomeOptions = {
  home?: string;
  platform?: string;
  fscheck?: (path: string) => FsCheck;
};

// Before anything is created: the platform, the filesystem of the nearest existing ancestor, and what's
// already in the home. Returns the resolved home, with layout published and runs/ present.
export function prepareHome(o: HomeOptions = {}): string {
  if ((o.platform ?? process.platform) !== 'darwin') {
    throw new HomeRefused('ecp needs macOS in this version: the coordinator lock is a BSD flock');
  }
  const fscheck = o.fscheck ?? ((p: string) => checkFilesystem(p));
  const want = resolve(o.home ?? homePath());
  let ancestor = want;
  while (!existsSync(ancestor)) {
    const up = dirname(ancestor);
    if (up === ancestor) throw new HomeRefused(`no existing ancestor for ${want}`);
    ancestor = up;
  }
  const realAncestor = realpathSync(ancestor);
  const first = fscheck(realAncestor);
  if (!first.ok) throw new HomeRefused(`unsupported filesystem: ${first.reason}`);
  const predicted = join(realAncestor, relative(ancestor, want));

  // A home that exists is checked before a single byte goes into it.
  const layoutPath = join(want, 'layout');
  if (existsSync(want)) {
    const layout = readLayout(layoutPath);
    const entries = readdirSync(want).filter((n) => !isLeftover(n));
    if (layout === null && entries.length > 0) {
      throw new HomeRefused(
        `${want} was made by another ecp version, or by something else: set ECP_HOME to a new directory`,
      );
    }
    if (layout !== null && layout !== LAYOUT) {
      throw new HomeRefused(`${want} has another layout: set ECP_HOME to a new directory`);
    }
  }
  mkdirSync(want, { recursive: true, mode: 0o700 });
  const real = realpathSync(want);
  if (real !== predicted)
    throw new HomeRefused(`${want} resolved to ${real}, not ${predicted}: a link appeared`);
  const second = fscheck(real);
  if (!second.ok) throw new HomeRefused(`unsupported filesystem: ${second.reason}`);

  // Published by link, which fails if layout exists, so two starts can't both write it.
  if (readLayout(join(real, 'layout')) === null) {
    const tmp = join(real, `layout.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, LAYOUT);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, join(real, 'layout'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EEXIST: another start published it first. ENOENT: another start already found a layout, and
      // cleared leftovers, this tmp among them. Either way the layout is read and checked below.
      if (code !== 'EEXIST' && code !== 'ENOENT') {
        rmSync(tmp, { force: true });
        throw new HomeRefused(`could not publish layout: ${(err as Error).message}`);
      }
    }
    rmSync(tmp, { force: true });
  }
  if (readLayout(join(real, 'layout')) !== LAYOUT) {
    throw new HomeRefused(`${real} has another layout: set ECP_HOME to a new directory`);
  }
  for (const name of readdirSync(real))
    if (isLeftover(name)) rmSync(join(real, name), { force: true });
  if (existsSync(join(real, 'run.lock'))) {
    throw new HomeRefused(
      `${real} holds an older version's run.lock: set ECP_HOME to a new directory`,
    );
  }
  const lockPath = join(real, 'coordinator.lock');
  // lstat, so a link is seen even when it points nowhere.
  let isLink = false;
  try {
    isLink = lstatSync(lockPath).isSymbolicLink();
  } catch {
    // Not there yet.
  }
  if (isLink) throw new HomeRefused(`${lockPath} is a link: refused`);
  mkdirSync(join(real, 'runs'), { recursive: true, mode: 0o700 });
  return real;
}

export const lockPathIn = (home: string) => join(home, 'coordinator.lock');
