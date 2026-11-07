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
  const { issue, verify } = await load('src/auth.mjs');
  const forged = `${Buffer.from(JSON.stringify({ user: 'root', alg: 'none' })).toString('base64url')}.`;
  check('exploit fails', verify(forged) === null);
  check('valid token', verify(issue('ann')) === 'ann');
  const [b] = issue('ann').split('.');
  check('bad signature', verify(`${b}.00`) === null);
  let threw = false;
  for (const t of ['', 'x', '%%%.y', 'e30', null]) { try { if (verify(t) !== null) threw = true; } catch { threw = true; } }
  check('malformed gives null', !threw);
  const pkg = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));
  check('no new dependency', Object.keys(pkg.dependencies ?? {}).length === 0);
  return true;
});
done();
