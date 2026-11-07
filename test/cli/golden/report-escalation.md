# SPEC-T — ESCALATION_REQUIRED
Needs your decision: HARD_GATE_BREACH: T1: HARD_GATE_BREACH
Decision needed: yes

## Result
Branch: ecp/run1/integration
Commit: none
Base: 3423925
See diff: git diff 3423925..none
Pushed: no: no publish block
Draft PR: none
Merged: no. Merging is yours

## Acceptance criteria (0/1)
- AC-1 NOT VERIFIED

## Checks
Gates: 23/24 (failed: H-SECRET)
Waivers: 0
Disagreements: 0
Claims: 4 verified, 0 corrected, 0 rejected, 0 unverified
Not examined: none listed

## Who did what
T1 work: mock-openai/mock-model-openai
T2 work: mock-openai/mock-model-openai
T2 review: mock-anthropic/mock-model-anthropic
Fallbacks: 0
Repairs: 0 total

## Cost and time
Elapsed: 0:00   Worker time: 0:00
Tokens: unavailable (0 of 4 measured)
Cost: unavailable (no source)
Human interventions: 0

## Shadow orchestrator (recorded, never executed)
Decision points: 6   Recorded: 0
Unavailable: 0   Skipped: 0
Agreement among recorded: 0/0
Would have broken a rule: 0
Observed later: consistent with coordinator 0,
  with shadow 0, undetermined 0
Owner preference: matched coordinator 0, shadow 0,
  neither 0, new information 0
Replayed: 0 of 0 disagreements
By point: none
By risk: none
By shadow model: none
Agreement alone can't justify steering in v0.2.

## Decision needed (escalations only)
Decision: HARD_GATE_BREACH
Why automation cannot decide: T1: HARD_GATE_BREACH
Options:
- retry_task: Counters reset; your note goes in the brief
- abandon: The run ends as CANCELLED
Resume: ecp resume run1 --with-decision <file>
