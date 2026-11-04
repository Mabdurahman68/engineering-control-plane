import type { Depth, Risk, Spec } from '../contracts/index.ts';
import type { Profiles, RiskRules } from '../contracts/profile.ts';
import { DEPTHS, RISKS } from '../contracts/index.ts';
import { globMatch } from '../gates/glob.ts';

export function maxRisk(...r: Risk[]): Risk {
  return r.reduce((a, b) => (RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b), 'low' as Risk);
}
export function maxDepth(a: Depth, b: Depth): Depth {
  return DEPTHS.indexOf(a) >= DEPTHS.indexOf(b) ? a : b;
}
export function effectiveDepth(requested: Depth, risk: Risk, profiles: Profiles): Depth {
  return maxDepth(requested, profiles.min_depth_for_risk[risk]);
}

// The same rules apply to declared surfaces at preflight and to changed paths after each task.
export function ruleRisk(
  rules: RiskRules,
  paths: string[],
  text = '',
  dataClasses: string[] = [],
): Risk {
  let out: Risk = 'low';
  let hit = false;
  for (const rule of rules.rules) {
    const w = rule.when;
    const matched =
      (w.path_glob !== undefined && paths.some((p) => globMatch(w.path_glob as string, p))) ||
      (w.keyword !== undefined && text.includes(w.keyword)) ||
      (w.data_class !== undefined && dataClasses.includes(w.data_class));
    if (matched) {
      hit = true;
      out = maxRisk(out, rule.min_risk);
    }
  }
  if (hit) return out;
  if (paths.length && paths.every((p) => rules.doc_globs.some((g) => globMatch(g, p)))) {
    return rules.doc_only_risk;
  }
  return paths.length ? rules.default_risk : 'low';
}

export function specRuleRisk(rules: RiskRules, spec: Spec): Risk {
  const text = [spec.goal, spec.product_behaviour, ...spec.invariants].join('\n');
  return ruleRisk(rules, spec.affected_surfaces, text, spec.data_classes);
}
