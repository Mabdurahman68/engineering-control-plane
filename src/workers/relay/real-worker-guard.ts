import { hostname } from 'node:os';
import { homePath } from '../../cli/home.ts';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import pins from './fake-cli-pins.json' with { type: 'json' };
import { fileSha } from './pins.ts';

// Real workers need a later owner release, which has to change this. Nothing at run time can.
export const BUILD_ALLOWS_REAL_WORKERS = false;

export const CLI_NAMES = ['codex', 'claude', 'opencode'] as const;

export type Proof = { provenance: string; passed: boolean; machine: string };

// The chain a real worker has to pass. The constant comes last, and is false in this build, so a real
// CLI is refused whatever files exist. A fake-actor proof never counts.
export function evaluateRealDispatch(o: {
  proof: Proof | null;
  release: { machine: string } | null;
  machine: string;
  buildAllows: boolean;
}): { allowed: boolean; reason: string } {
  if (!o.proof) return { allowed: false, reason: 'no isolation proof on this machine' };
  if (o.proof.provenance !== 'real_actors')
    return { allowed: false, reason: `the proof came from ${o.proof.provenance}, not real actors` };
  if (!o.proof.passed) return { allowed: false, reason: 'the isolation proof did not pass' };
  if (o.proof.machine !== o.machine)
    return { allowed: false, reason: 'the proof is from another machine' };
  if (!o.release || o.release.machine !== o.machine)
    return { allowed: false, reason: 'no owner release for real workers' };
  if (!o.buildAllows) return { allowed: false, reason: 'this build refuses real workers' };
  return { allowed: true, reason: 'released' };
}

export type Authorised =
  | { allowed: true; provenance: 'fake_cli'; paths: Record<string, string> }
  | { allowed: false; reason: string; path: string | null };

// An empty or relative entry means a different file from a different working directory, so the first
// match can't be known here. Such a PATH is refused, not skipped.
function resolveOnPath(
  name: string,
  pathVar: string,
): { found: string | null; bad: string | null } {
  for (const dir of pathVar.split(delimiter)) {
    if (!isAbsolute(dir)) return { found: null, bad: dir === '' ? '(empty)' : dir };
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return { found: candidate, bad: null };
    } catch {
      // Keep looking.
    }
  }
  return { found: null, bad: null };
}

// Fixtures are identified by location and hash only. No file authorises itself by what it says. Every
// CLI name the relays can call has to resolve, on the exact PATH they'll get, to its pinned fixture.
// Anything else is real, and real is refused while the constant above is false.
export function authoriseClis(repoRoot: string, pathVar: string): Authorised {
  const binDir = realpathSync(resolve(repoRoot, 'test/fake-cli/bin'));
  const table = pins as Record<string, string>;
  const paths: Record<string, string> = {};
  for (const name of CLI_NAMES) {
    const { found, bad } = resolveOnPath(name, pathVar);
    if (bad !== null) return refuse(name, `a PATH entry that isn't absolute: ${bad}`);
    if (!found) return refuse(name, "nothing: it isn't on PATH");
    const real = realpathSync(found);
    // A link into the directory from elsewhere fails too: the launcher finds its core beside itself.
    if (
      join(realpathSync(dirname(found)), name) !== join(binDir, name) ||
      real !== join(binDir, name)
    ) {
      return refuse(name, real);
    }
    const pinned = table[name];
    if (!pinned || fileSha(real) !== pinned) return refuse(name, real);
    paths[name] = real;
  }
  // The launchers run this one file, so it has to match as well.
  const core = join(binDir, 'fake-cli-core.mjs');
  if (!existsSync(core) || fileSha(core) !== table['fake-cli-core.mjs']) {
    return refuse('fake-cli-core.mjs', core);
  }
  return { allowed: true, provenance: 'fake_cli', paths };
}

function refuse(name: string, path: string): Authorised {
  const chain = evaluateRealDispatch({
    proof: readProof(),
    release: null,
    machine: machineId(),
    buildAllows: BUILD_ALLOWS_REAL_WORKERS,
  });
  return {
    allowed: false,
    reason: `${name} resolves to ${path}: a real CLI. ${chain.reason}`,
    path,
  };
}

export function machineId(): string {
  return hostname();
}

export function proofPath(): string {
  return join(homePath(), 'isolation-proof.json');
}

function readProof(): Proof | null {
  const p = proofPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
