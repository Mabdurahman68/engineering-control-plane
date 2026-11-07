import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MockWorld } from './mock-adapter.ts';

// The mock's effects on a real worktree. Used only with mock scripts: no CLI, no model.
export class RealMockWorld implements MockWorld {
  writeFile(cwd: string, path: string, content: string | null) {
    const p = join(cwd, path);
    if (content === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
  commitHead(cwd: string) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'w',
      GIT_AUTHOR_EMAIL: 'w@example.invalid',
      GIT_COMMITTER_NAME: 'w',
      GIT_COMMITTER_EMAIL: 'w@example.invalid',
    };
    execFileSync('git', ['add', '-A'], { cwd, env });
    execFileSync('git', ['commit', '-qm', 'worker commit', '--allow-empty'], { cwd, env });
  }
  tamperConfig(cwd: string) {
    execFileSync('git', ['config', 'core.tampered', 'true'], { cwd });
  }
  readFileIn(cwd: string, path: string) {
    const p = join(cwd, path);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  readBrief(path: string) {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
}
