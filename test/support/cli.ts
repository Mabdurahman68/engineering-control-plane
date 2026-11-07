import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { defaultPlan, testPolicy, testSpec } from './harness.ts';
import { makeRepo, tempDir } from './repo.ts';

const MAIN = resolve('src/cli/main.ts');

export function cliEnv(
  o: {
    script?: any[];
    spec?: any;
    plan?: any;
    policy?: (p: any) => void;
    files?: Record<string, string>;
  } = {},
) {
  const home = tempDir('ecp-home-');
  const repo = makeRepo(o.files ?? { 'README.md': 'x\n' });
  const dir = tempDir('ecp-cfg-');
  const policyDir = join(dir, 'policy');
  mkdirSync(policyDir);
  const policy = testPolicy(o.policy);
  const files: Record<string, any> = {
    'workers.yaml': policy.workers,
    'families.yaml': policy.families,
    'profiles.yaml': policy.profiles,
    'risk-rules.yaml': policy.riskRules,
    'failure-classes.yaml': policy.failureClasses,
    'cli-versions.yaml': policy.cliVersions,
    'secret-patterns.yaml': policy.secretPatterns,
    'settings.yaml': policy.settings,
  };
  for (const [f, v] of Object.entries(files)) writeFileSync(join(policyDir, f), stringify(v));
  const node = process.execPath;
  const spec = {
    ...testSpec(repo.base, {
      target: { repo_path: repo.dir, base_commit: repo.base, repo_identity: repo.base },
      required_tests: [{ id: 'unit', command: [node, '-e', 'process.exit(0)'], timeout_s: 30 }],
      full_test_command: { command: [node, '-e', 'process.exit(0)'], timeout_s: 30 },
    }),
    ...o.spec,
  };
  const specPath = join(dir, 'spec.yaml');
  writeFileSync(specPath, stringify(spec));
  const scriptPath = join(dir, 'script.yaml');
  writeFileSync(
    scriptPath,
    stringify({
      schema: 'mock_script.v1',
      steps: o.script ?? [],
      default_plan: o.plan ?? defaultPlan(),
    }),
  );
  const env = { ...process.env, ECP_HOME: home };
  delete (env as any).ECP_FAILPOINT;
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [MAIN, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 120_000,
    });
  const runAsync = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }>(
      (res) => {
        const c = spawn(process.execPath, [MAIN, ...args], {
          env: { ...env, ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d) => (stdout += d));
        c.stderr.on('data', (d) => (stderr += d));
        c.on('close', (status, signal) => res({ status, signal, stdout, stderr }));
      },
    );
  return {
    home,
    repo,
    policyDir,
    specPath,
    scriptPath,
    run,
    runAsync,
    startArgs: (id = 'r1') => [
      'run',
      specPath,
      '--mock-script',
      scriptPath,
      '--policy',
      policyDir,
      '--run-id',
      id,
    ],
  };
}
