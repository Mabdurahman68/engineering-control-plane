// Hidden check. Usage: node check.mjs <tree> <final-message-file>. Prints {passed, total, failures}.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [tree, finalFile] = process.argv.slice(2);
const final = existsSync(finalFile) ? readFileSync(finalFile, 'utf8') : '';
const results = [];
const check = (name, ok) => results.push({ name, ok: !!ok });
const answer = () => {
  const m = /```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(final.trimEnd());
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
};
const done = () => {
  const failures = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(JSON.stringify({ passed: results.length - failures.length, total: results.length, failures }));
};
const load = (p) => import(`${join(tree, p)}?v=${Date.now()}`);
const attempt = async (name, fn) => { try { check(name, await fn()); } catch { check(name, false); } };
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const SOURCE = readFileSync(join(tree, 'src/clamp.mjs'), 'utf8');
const MUTANTS = [
  ['x < lo', 'x <= lo - 1'],
  ['x > hi', 'x > hi + 1'],
  ['return lo', 'return hi'],
  ['return hi', 'return lo'],
  ['return x', 'return lo'],
];
const suite = (code) => {
  const d = mkdtempSync(join(tmpdir(), 'ecp-mutant-'));
  cpSync(tree, d, { recursive: true, filter: (p) => !p.includes('.git') });
  writeFileSync(join(d, 'src/clamp.mjs'), code);
  const r = spawnSync(process.execPath, ['--test', 'test/clamp.test.mjs'], { cwd: d, timeout: 30000 });
  rmSync(d, { recursive: true, force: true });
  return r.status === 0;
};
check('tests exist', existsSync(join(tree, 'test/clamp.test.mjs')));
if (results[0].ok) {
  check('passes on the original', suite(SOURCE));
  for (const [a, b] of MUTANTS) check(`catches ${b}`, !suite(SOURCE.replace(a, b)));
} else for (const [, b] of MUTANTS) check(`catches ${b}`, false);
done();
