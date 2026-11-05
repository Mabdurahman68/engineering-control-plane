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
await attempt('load', async () => {
  const lib = await load('src/lib.ts');
  const s = await load('src/strings.ts');
  const n = await load('src/numbers.ts');
  check('slug', lib.slug(' A b! ') === 'a-b' && s.slug('C d') === 'c-d');
  check('title', lib.title('hELLO wORLD') === 'Hello World' && s.title('x') === 'X');
  check('sum', lib.sum([1, 2]) === 3 && n.sum([]) === 0);
  check('mean', lib.mean([2, 4]) === 3 && n.mean([]) === 0);
  check('lib only re-exports', !/function /.test(readFileSync(join(tree, 'src/lib.ts'), 'utf8')));
  return true;
});
done();
