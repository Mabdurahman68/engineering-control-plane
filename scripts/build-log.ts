// Runs a gate command and appends its command, exit code and commit to docs/BUILD_LOG.md.
// Usage: pnpm build-log <milestone> -- <command...>
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const milestone = args[0];
const sep = args.indexOf('--');
const cmd = args.slice(sep + 1);
if (!milestone || sep < 0 || cmd.length === 0) {
  console.error('usage: build-log <milestone> -- <command...>');
  process.exit(2);
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
const started = Date.now();
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
const code = r.status ?? 1;
const line = `| ${milestone} | \`${cmd.join(' ')}\` | ${code} | ${commit}${dirty ? ' (dirty)' : ''} | ${Math.round((Date.now() - started) / 1000)}s |\n`;
appendFileSync('docs/BUILD_LOG.md', line);
process.exit(code);
