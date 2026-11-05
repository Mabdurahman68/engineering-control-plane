// Executed rule removal (§4B): each safety test is shown to fail with its rule removed. Reading a test
// proves nothing. Every rule runs in a disposable worktree of the candidate commit.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { REQUIRED_RULES } from '../test/rule-removal/required-rules.ts';

type Named = { file: string; test_name: string };
type Rule = {
  id: string;
  source: string;
  patch: string;
  removes: string;
  removed_predicate: string;
  touches: string[];
  must_fail: Named[];
  must_pass: Named[];
  env?: Record<string, string>;
};

const { values } = parseArgs({
  options: {
    rule: { type: 'string', multiple: true },
    registry: { type: 'string' },
    'extra-required': { type: 'string', multiple: true },
    'skip-completeness': { type: 'boolean' },
    jobs: { type: 'string' },
  },
});
const ROOT = process.cwd();
const registryPath = resolve(values.registry ?? 'test/rule-removal/registry.yaml');
const registry = parse(readFileSync(registryPath, 'utf8')) as { rules: Rule[] };
const out =
  process.env.ECP_RESULTS ?? join(homedir(), '.ecp/build-reviews/rule-removal-results.json');
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = sh(ROOT, 'rev-parse', 'HEAD');
const tree = sh(ROOT, 'rev-parse', 'HEAD^{tree}');

if (!values['skip-completeness']) {
  const required = [...REQUIRED_RULES, ...(values['extra-required'] ?? [])];
  const known = new Set(registry.rules.map((r) => r.id));
  const missing = required.filter((id) => !known.has(id));
  if (missing.length) {
    console.error(`unregistered rules: ${missing.join(', ')}`);
    process.exit(1);
  }
}

type VitestTest = { fullName: string; status: string; failureMessages: string[] };

function runTests(dir: string, files: string[], env: Record<string, string> = {}) {
  const report = join(dir, `.vitest-${Date.now()}-${Math.random()}.json`);
  const r = spawnSync(
    join(dir, 'node_modules/.bin/vitest'),
    ['run', ...new Set(files), '--reporter=json', `--outputFile=${report}`],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 1_500_000 },
  );
  const tests: VitestTest[] = existsSync(report)
    ? JSON.parse(readFileSync(report, 'utf8')).testResults.flatMap((f: any) =>
        f.assertionResults.map((a: any) => ({
          fullName: a.fullName,
          status: a.status,
          failureMessages: a.failureMessages ?? [],
          file: f.name,
        })),
      )
    : [];
  return { code: r.status ?? 1, tests };
}

const matching = (tests: VitestTest[], n: Named) =>
  tests.filter((t) => t.fullName.includes(n.test_name));

async function runRule(rule: Rule) {
  const result: any = {
    commit,
    tree,
    rule_id: rule.id,
    source: rule.source,
    removes: rule.removes,
    removed_predicate: rule.removed_predicate,
    patch: rule.patch,
    patch_sha256: null,
    touches: rule.touches,
    steps: {},
    failing_tests: [],
    sibling_results: [],
    ok: false,
    reason: null,
  };
  const stop = (reason: string) => {
    result.reason = reason;
    return result;
  };
  const patchPath = resolve(rule.patch);
  if (!existsSync(patchPath)) return stop('patch missing');
  result.patch_sha256 = createHash('sha256').update(readFileSync(patchPath)).digest('hex');
  const dir = mkdtempSync(join(tmpdir(), `ecp-removal-${rule.id}-`));
  try {
    sh(ROOT, 'worktree', 'add', '-q', '--detach', dir, commit);
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    const files = [...rule.must_fail, ...rule.must_pass].map((n) => n.file);

    // Unpatched, every named test passes.
    const before = runTests(dir, files, rule.env);
    result.steps.unpatched = before.code;
    for (const n of [...rule.must_fail, ...rule.must_pass]) {
      const hits = matching(before.tests, n);
      if (hits.length === 0) return stop(`no test named: ${n.test_name}`);
      if (hits.some((t) => t.status !== 'passed')) return stop(`fails unpatched: ${n.test_name}`);
    }

    // It applies, and it touches only what it says, under src/.
    const apply = spawnSync('git', ['apply', patchPath], { cwd: dir, encoding: 'utf8' });
    result.steps.apply = apply.status;
    if (apply.status !== 0) return stop(`patch does not apply: ${apply.stderr.trim()}`);
    const changed = sh(dir, 'diff', '--name-only').split('\n').filter(Boolean);
    if (changed.length === 0) return stop('patch changed nothing');
    const outside = changed.filter((f) => !rule.touches.includes(f) || !f.startsWith('src/'));
    if (outside.length) return stop(`patch touches ${outside.join(', ')}`);

    // A compile error can't count as detection.
    const tsc = spawnSync(join(dir, 'node_modules/.bin/tsc'), ['--noEmit'], {
      cwd: dir,
      encoding: 'utf8',
    });
    result.steps.typecheck = tsc.status;
    if (tsc.status !== 0) return stop(`patched code doesn't compile: ${tsc.stdout.slice(0, 400)}`);

    // Each must_fail test fails by an assertion carrying this rule's token.
    const after = runTests(dir, files, rule.env);
    result.steps.patched = after.code;
    const token = `FORBIDDEN_OUTCOME:${rule.id}`;
    for (const n of rule.must_fail) {
      const hits = matching(after.tests, n);
      if (hits.length === 0) return stop(`no test named, patched: ${n.test_name}`);
      for (const t of hits) {
        const message = t.failureMessages.join('\n');
        if (t.status !== 'failed') return stop(`survived: ${t.fullName}`);
        if (!message.includes('AssertionError') || !message.includes(token)) {
          return stop(`patch_not_targeted: ${t.fullName}: ${message.slice(0, 200)}`);
        }
        result.failing_tests.push({ name: t.fullName, message: message.slice(0, 400) });
      }
    }
    // Its siblings still pass, so the patch didn't just disable the module.
    for (const n of rule.must_pass) {
      for (const t of matching(after.tests, n)) {
        result.sibling_results.push({ name: t.fullName, status: t.status });
        if (t.status !== 'passed') return stop(`a sibling broke: ${t.fullName}`);
      }
    }
    result.ok = true;
    return result;
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT });
    rmSync(dir, { recursive: true, force: true });
  }
}

const chosen = values.rule
  ? registry.rules.filter((r) => (values.rule as string[]).includes(r.id))
  : registry.rules;
if (values.rule && chosen.length !== values.rule.length) {
  console.error('an unregistered rule was asked for');
  process.exit(1);
}
const results: any[] = [];
let next = 0;
// Serial by default. Each runs real processes, some sensitive to load.
await Promise.all(
  Array.from({ length: Number(values.jobs ?? 1) }, async () => {
    while (next < chosen.length) {
      const rule = chosen[next++] as Rule;
      const r = await runRule(rule);
      results.push(r);
      console.log(
        `${r.ok ? 'removed and caught' : 'FAILED'} ${r.rule_id}${r.reason ? `: ${r.reason}` : ''}`,
      );
    }
  }),
);
writeFileSync(out, `${JSON.stringify({ commit, tree, results }, null, 2)}\n`);
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length} of ${results.length} rules shown; results in ${out}`);
process.exit(bad.length ? 1 : 0);
