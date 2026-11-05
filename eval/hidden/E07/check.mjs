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
  const { dedupe } = await load('src/dedupe.mjs');
  check('order', dedupe([3, 1, 3, 2, 1]).join() === '3,1,2');
  check('empty', dedupe([]).length === 0);
  const xs = Array.from({ length: 100000 }, (_, i) => i);
  const t = performance.now();
  const out = dedupe(xs);
  check('under the target', performance.now() - t < 150 && out.length === 100000);
  return true;
});
done();
