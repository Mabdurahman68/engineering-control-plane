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
  const { handle } = await load('src/service.ts');
  check('found', handle('GET', '/items/a1').status === 200 && handle('GET', '/items/a1').body.name === 'first');
  check('missing', handle('GET', '/items/zz').status === 404 && handle('GET', '/items/zz').body.error === 'not_found');
  check('bad id', handle('GET', '/items/a-1').status === 400 && handle('GET', '/items/a-1').body.error === 'bad_id');
  check('list unchanged', handle('GET', '/items').body.length === 2);
  check('other methods', handle('POST', '/items/a1').status === 404);
  return true;
});
done();
