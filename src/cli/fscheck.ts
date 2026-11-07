import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';

// The lock is a kernel lock, and only means one owner on a local filesystem that implements it. This
// finds the filesystem that really holds a path, and refuses anything it can't positively identify as a
// local APFS or HFS volume. It never guesses.
export type FsCheck = { ok: true; mount: string; type: string } | { ok: false; reason: string };

export type FsProbes = {
  run: (cmd: string, args: string[]) => { code: number; stdout: string };
  statfsType: (path: string) => number;
};

const REAL: FsProbes = {
  run: (cmd, args) => {
    try {
      return {
        code: 0,
        stdout: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
      };
    } catch (err) {
      return { code: (err as { status?: number }).status ?? 1, stdout: '' };
    }
  },
  statfsType: (path) => Number(statfsSync(path).type),
};

const SUPPORTED = new Set(['apfs', 'hfs']);
const MOUNT_LINE = /^(.+?) on (.+) \(([^()]*)\)$/;

export function checkFilesystem(target: string, probes: FsProbes = REAL): FsCheck {
  const no = (reason: string): FsCheck => ({ ok: false, reason: `${target}: ${reason}` });
  // df resolves the path with statfs, so "Mounted on" is the mount that really holds it.
  const df = probes.run('/bin/df', ['-P', target]);
  if (df.code !== 0) return no('df failed');
  const lines = df.stdout.trim().split('\n');
  if (lines.length !== 2 || !lines[0]?.startsWith('Filesystem'))
    return no('df output not understood');
  const fields = (lines[1] as string).trim().split(/\s+/);
  // Six fields exactly: a mount point with whitespace would split, and is refused rather than guessed at.
  if (fields.length !== 6) return no('df output not understood, or a mount point with whitespace');
  const mount = fields[5] as string;
  if (!mount.startsWith('/') || /[\\\s]/.test(mount))
    return no(`mount point not understood: ${mount}`);
  const mt = probes.run('/sbin/mount', []);
  if (mt.code !== 0) return no('mount failed');
  const matches: { type: string; flags: string[] }[] = [];
  for (const line of mt.stdout.split('\n')) {
    const m = MOUNT_LINE.exec(line.trim());
    if (!m || m[2] !== mount) continue;
    const [type, ...flags] = (m[3] as string).split(',').map((x) => x.trim());
    matches.push({ type: type ?? '', flags });
  }
  if (matches.length !== 1) return no(`${matches.length} mount entries for ${mount}`);
  const { type, flags } = matches[0] as { type: string; flags: string[] };
  if (!SUPPORTED.has(type))
    return no(`filesystem ${type || 'unknown'} is not supported: local APFS or HFS only`);
  if (!flags.includes('local')) return no(`${mount} is not marked local`);
  // Corroboration, not identity: the path and the mount point report the same filesystem type.
  try {
    if (probes.statfsType(target) !== probes.statfsType(mount))
      return no('statfs disagrees with mount');
  } catch {
    return no('statfs failed');
  }
  return { ok: true, mount, type };
}
