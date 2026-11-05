# SPEC-T — MOCK_RUN_COMPLETE
MOCK RUN — orchestration only; no semantic approval was given
Decision needed: no

## Result
Branch: ecp/run1/integration
Commit: 96f2092
Base: 3423925
See diff: git diff 3423925..96f2092
Pushed: no: no publish block
Draft PR: none
Merged: no. Merging is yours

## Acceptance criteria (1/1)
- AC-1 PASS — reviewed

## Checks
Gates: 46/46
Waivers: 0
Disagreements: 0
Claims: 6 verified, 0 corrected, 0 rejected, 0 unverified
Not examined: none listed

## Who did what
T1 work: mock-openai/mock-model-openai
T2 work: mock-openai/mock-model-openai
T1 review: mock-anthropic/mock-model-anthropic
T2 review: mock-anthropic/mock-model-anthropic
T3 work: mock-openai/mock-model-openai
T3 review: mock-anthropic/mock-model-anthropic
Fallbacks: 0
Repairs: 0 total

## Cost and time
Elapsed: 0:00   Worker time: 0:00
Tokens: unavailable (0 of 8 measured)
Cost: unavailable (no source)
Human interventions: 0

## Shadow orchestrator (recorded, never executed) — MOCK
Decision points: 8   Recorded: 8
Unavailable: 0   Skipped: 0
Agreement among recorded: 7/8
Would have broken a rule: 2
Observed later: consistent with coordinator 2,
  with shadow 0, undetermined 6
Owner preference: matched coordinator 0, shadow 0,
  neither 0, new information 0
Replayed: 0 of 1 disagreements
By point: DP-GATES 3/3; DP-PLAN 1/1; DP-REVIEW 2/3; DP-VERIFY 1/1
By risk: low 7/8
By shadow model: mock-model-anthropic 6/7; mock-model-openai 1/1
- DP-0004 DP-REVIEW T1
  Coordinator: accept_task
  Shadow: escalate (anthropic)
  Why: "I would stop here"
  Illegal: no row from REVIEWING
Agreement alone can't justify steering in v0.2.
