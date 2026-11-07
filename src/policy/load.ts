import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ZodType } from 'zod';
import type { PolicyBundle } from '../contracts/index.ts';
import {
  cliVersionsSchema,
  failureClassesSchema,
  familiesSchema,
  profilesSchema,
  riskRulesSchema,
  secretPatternsSchema,
  settingsSchema,
  workersSchema,
} from '../contracts/index.ts';
import { canonical, sha256 } from '../ledger/canonical.ts';

const FILES: [keyof PolicyBundle, string, ZodType][] = [
  ['workers', 'workers.yaml', workersSchema],
  ['families', 'families.yaml', familiesSchema],
  ['profiles', 'profiles.yaml', profilesSchema],
  ['riskRules', 'risk-rules.yaml', riskRulesSchema],
  ['failureClasses', 'failure-classes.yaml', failureClassesSchema],
  ['cliVersions', 'cli-versions.yaml', cliVersionsSchema],
  ['secretPatterns', 'secret-patterns.yaml', secretPatternsSchema],
  ['settings', 'settings.yaml', settingsSchema],
];

export function loadPolicy(dir: string): PolicyBundle {
  const out: Record<string, unknown> = {};
  for (const [key, file, schema] of FILES) {
    const res = schema.safeParse(parse(readFileSync(join(dir, file), 'utf8')));
    if (!res.success) throw new Error(`policy file ${file} is invalid: ${res.error.message}`);
    out[key] = res.data;
  }
  return out as PolicyBundle;
}

// Hashes the parsed policy plus prompt templates, so any change needs --accept-policy-change.
export function policyHash(policy: PolicyBundle, promptsDir?: string): string {
  const prompts: Record<string, string> = {};
  if (promptsDir && existsSync(promptsDir)) {
    for (const f of readdirSync(promptsDir).sort()) {
      prompts[f] = sha256(readFileSync(join(promptsDir, f)));
    }
  }
  return sha256(canonical({ policy, prompts }));
}

export function assertMixedFamilies(policy: PolicyBundle): string[] {
  const warnings: string[] = [];
  const fam = new Set<string>();
  for (const r of Object.values(policy.workers.rungs)) {
    const f = policy.families.models[r.model];
    if (f) fam.add(f);
  }
  if (fam.size < 2) throw new Error('fewer than two families are configured');
  if (fam.size < 3) warnings.push('fewer than three families configured');
  const ladders = policy.workers.ladders;
  const familyOf = (r: string) => policy.families.models[policy.workers.rungs[r]?.model];
  for (const lane of [
    'research',
    'implementation',
    'hard-code',
    'tests',
    'integration-repair',
  ] as const) {
    for (const r of ladders[lane].slice(0, 1)) {
      if (!ladders.review.some((x) => familyOf(x) && familyOf(x) !== familyOf(r))) {
        throw new Error(`ladder ${lane} couldn't get an independent reviewer for ${r}`);
      }
    }
  }
  return warnings;
}
