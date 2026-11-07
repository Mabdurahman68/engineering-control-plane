import { describe, expect, it } from 'vitest';
import { ANY_STEP, STEP } from '../../support/fuzz-run.ts';

describe('the hole test drives what AC-B names', () => {
  it('names every agent step but the shadow, whose behaviours its own suite drives', () => {
    expect(Object.keys(STEP).sort()).toEqual(
      [
        'acceptance',
        'adjudicate',
        'adversarial',
        'challenge',
        'lens',
        'plan',
        'plan_review',
        'repair',
        'review',
        'work',
      ].sort(),
    );
  });
  it.each(Object.entries(STEP))('%s has every failure any step can have', (_step, list) => {
    for (const b of ANY_STEP) expect(list).toContain(b);
  });
  it('workers and reviewers have their own behaviours too', () => {
    for (const b of [
      'edit_out_of_scope',
      'edit_control_file',
      'commit_head',
      'write_secret',
      'weaken_test',
      'claim_false_count',
      'claim_tests_passed_false',
      'no_change',
      'oscillate',
      'reports_touched_files',
      'dispute_finding',
      'dispute_no_evidence',
    ]) {
      expect(STEP.work).toContain(b);
    }
    for (const b of [
      'reviewer_pass',
      'reviewer_fail',
      'reviewer_inconsistent',
      'reviewer_modifies_tree',
      'reviewer_incomplete',
      'reviewer_pass_with_blocker',
      'reported_family_mismatch',
    ]) {
      expect(STEP.review).toContain(b);
    }
  });
});
