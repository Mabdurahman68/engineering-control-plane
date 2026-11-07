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
const a = answer();
const hz = (f, re) => (a?.hazards ?? []).some((h) => h.file?.endsWith(f) && re.test(h.why ?? ''));
check('dropped column loses data', hz('001_users.sql', /data|irreversib|lost|loss/i));
check('enum rename breaks readers', hz('002_status.sql', /rename|reader|client|compat/i));
check('harmless index not raised as a hazard', !(a?.hazards ?? []).some((h) => h.file?.endsWith('003_index.sql')));
const rb = (f, re) => (a?.rollback ?? []).some((r) => r.file?.endsWith(f) && re.test(r.step ?? ''));
check('rollback restores from a backup', rb('001_users.sql', /backup|restore/i));
check('rollback renames back', rb('002_status.sql', /rename/i));
done();
