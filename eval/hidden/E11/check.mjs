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
const REAL = ['src/pay.mjs:refund', 'src/session.mjs:expiry', 'src/store.mjs:query'];
const found = (answer()?.findings ?? []).map((f) => `${f.file}:${f.hunk}`);
const tp = REAL.filter((r) => found.includes(r)).length;
const recall = tp / REAL.length;
const precision = found.length ? found.filter((f) => REAL.includes(f)).length / found.length : 0;
check('recall', recall === 1);
check('precision', precision >= 0.75);
console.error(JSON.stringify({ recall, precision }));
done();
