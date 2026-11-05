import { spawnSync } from 'node:child_process';
import { authoriseClis } from './real-worker-guard.ts';

export class CliRefused extends Error {}

// Every run of a coding CLI goes through here, including --version, --help and auth probes. The guard
// runs first, with no exception: a program posing as a CLI gets no chance to act.
export function execCli(
  repoRoot: string,
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { code: number; stdout: string; stderr: string } {
  const auth = authoriseClis(repoRoot, env.PATH ?? '');
  if (!auth.allowed) throw new CliRefused(auth.reason);
  const r = spawnSync(auth.paths[name] as string, args, {
    env,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
