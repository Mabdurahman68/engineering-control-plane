import { AssertionError } from 'node:assert';

// Safety tests assert the forbidden behaviour through this helper. The rule-removal harness requires
// the failure message to carry the rule's token, so a patch that only renames a diagnostic can't count.
export function assertNotForbidden(ruleId: string, happened: boolean, detail = ''): void {
  if (happened) {
    throw new AssertionError({
      message: `FORBIDDEN_OUTCOME:${ruleId} ${detail}`.trim(),
      actual: true,
      expected: false,
    });
  }
}
