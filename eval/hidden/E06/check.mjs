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
  const { Queue } = await load('src/queue.mjs');
  let worst = 0;
  for (let round = 0; round < 50; round++) {
    const q = new Queue(2);
    let live = 0;
    const job = async () => { live++; worst = Math.max(worst, live); await new Promise((r) => setTimeout(r, Math.random() * 2)); live--; };
    const jobs = [q.run(job), q.run(job), q.run(job)];
    await jobs[0];
    jobs.push(q.run(job), q.run(job));
    await Promise.all(jobs);
  }
  check('never over the limit', worst <= 2);
  const q = new Queue(1);
  const order = [];
  await Promise.all([1, 2, 3].map((n) => q.run(async () => { order.push(n); })));
  check('runs every task in order', order.join() === '1,2,3');
  await q.run(async () => { throw new Error('x'); }).catch(() => {});
  check('a failure frees the slot', (await q.run(async () => 7)) === 7);
  return true;
});
done();
