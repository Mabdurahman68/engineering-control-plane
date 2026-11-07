import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tempDir } from './repo.ts';

export const FIXTURE_BIN = resolve('test/fake-cli/bin');
// The prefix is for a run under an OS sandbox, which can only reach `ps` through a helper.
const PREFIX = process.env.ECP_TEST_PATH_PREFIX ? `${process.env.ECP_TEST_PATH_PREFIX}:` : '';
const SYSTEM = `${PREFIX}${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;

// A HOME for the fixtures, holding their script, plus the PATH that finds them first.
export function fakeWorld(steps: any[] = [], o: { before?: string[] } = {}) {
  const home = tempDir('ecp-fake-home-');
  writeFileSync(join(home, 'fake-cli-script.json'), JSON.stringify({ steps }));
  const path = [...(o.before ?? []), FIXTURE_BIN, SYSTEM].join(':');
  return { home, path, env: { HOME: home, PATH: path } };
}

// A dispatch request of the shape the engine sends.
export function fakeRequest(dir: string, over: Record<string, unknown> = {}) {
  const out_dir = join(dir, 'attempt');
  mkdirSync(out_dir, { recursive: true });
  const brief_path = join(out_dir, 'brief.txt');
  writeFileSync(brief_path, 'Implement the task below.\n');
  return {
    attempt_id: 'A-1',
    brief_path,
    cwd: dir,
    out_dir,
    model: 'fake-model',
    effort: 'high',
    mode: 'write' as const,
    timeout_s: 60,
    session_id: null,
    env_allowlist: [],
    ...over,
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The fixtures' own record of each worker they started: the harness's PIDs, not the scan's.
export function loggedWorkers(home: string): { pid: number; cwd: string; kind: string }[] {
  const p = join(home, 'fake-cli-calls.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function ledgerEvents(ecpHome: string, runId: string): any[] {
  const p = join(ecpHome, 'runs', runId, 'ledger', 'events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

export async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}
