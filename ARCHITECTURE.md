# Engineering Control Plane — Architecture

**Status:** core architecture defined; v0.1 in development. A manually coordinated predecessor of this process has delivered real software. This document specifies the autonomous system being built to replace those manual handoffs.

## Goal

A frozen specification goes in. A verified implementation candidate, or a concise genuine escalation, comes out. No human relays output between agents in between.

```
SPEC FROZEN → plan → decompose → dispatch workers → implement → mechanical gates
→ independent review → repair → re-test → verify against spec → integrate
→ READY_FOR_HUMAN_MERGE   (or: ESCALATION_REQUIRED, with evidence)
```

Staging and release stages belong to later maturity levels (see Autonomy ladder).

## Core conclusion

Agentic judgment, constrained and verified by deterministic machinery, with independent heterogeneous review.

Two extremes were rejected:

- **A deterministic state machine controlling everything.** Engineering requires semantic judgment: is a failing test stale because the spec changed behaviour on purpose? Is a zero-conflict merge semantically unsafe? Code cannot answer these reliably.
- **One autonomous model controlling everything.** Models hallucinate completion, forget gates, reconcile counts incorrectly, silently waive failures, and review their own assumptions.

## Laws

1. **No model certifies its own work.** Same-model adversarial rounds are useful; they are not independent sign-off. For consequential work: primary model + different-model reviewer + mechanical evidence.
2. **Anything mechanically provable is mechanically proved.** Counts, hashes, test totals and schema consistency are reconciled by code, never by a model.
3. **Evidence convergence outranks eloquence.** Authority is claim + source evidence + mechanical verification + independent semantic review. A polished report is not authority.
4. **Models are disposable; state is durable.** Every orchestrator, worker and reviewer invocation starts fresh. Truth lives in run state, the repo, artifacts and an append-only event ledger. This avoids context rot.
5. **Disagreement is a first-class state.** `MECHANICAL_PASS / SEMANTIC_FAIL` is a valid state. An agent that believes a gate is stale files a `GATE_CHALLENGE` with evidence; it never skips the gate.

## Components

- **Orchestrator (agentic).** Receives the spec, current run state, relevant evidence, policy and open failures; returns the next transition, tasks to dispatch, the reason, and the evidence required; then terminates. A later transition invokes a fresh orchestrator context.
- **State and policy engine (deterministic).** Owns valid transitions. An agent cannot move a run past a required gate.
- **Evidence engine (deterministic).** Runs lint, typecheck, unit and integration tests, build, schema validation and security scanners; emits structured evidence.
- **Workers (replaceable).** Routed by lane (research, implementation, hard implementation, review) across models through pinned CLI adapters. Same task contract, same evidence contract, same tests, same reviewer, whatever the vendor.
- **Worktree isolation.** Every task runs in its own git worktree with a bounded write surface. Task outputs become candidate commits for later integration.

## Contracts

**Spec.** Goal, product behaviour, architecture decisions, non-goals, affected surfaces, security and data invariants, backward compatibility, acceptance criteria (individually addressable: AC-1, AC-2, …), required tests, performance and deployment constraints, rollback expectations, human-decision boundaries.

**Task.** `task_id, spec_id, goal, allowed_paths, forbidden_paths, acceptance_criteria, required_tests, dependencies, risk`. A worker never needs the authoring conversation.

**Result.** `task_id, status, worker, session_id, touched_files, tests_run, known_issues, claims`. Every claim is independently validated.

**Claim ledger.** `claim_id, claim, type, evidence, asserted_by, mechanically_verified, independent_review`. Code checks that ledger counts, inventory rows and report figures agree; any mismatch blocks the transition.

## Gates

- **Hard gates.** Cannot be overridden by any agent: wrong repo identity, dirty working tree, forbidden production mutation, missing mandatory independent review, secret exposure, force-push, missing mandatory test execution. Changing one requires a deliberate policy change.
- **Soft gates.** Can be challenged with evidence, e.g. a legacy regression suite asserting intentionally superseded behaviour. The challenge is an object (`gate, code_result, agent_position, reason, evidence, requested_action`) adjudicated by policy or a reviewer, and every waiver appears in the final run report.
- **Semantic gates.** Judgment: architecture fidelity, spec satisfaction, semantic merge compatibility, security implications, whether a test actually tests the intended contract.

## Review

1. **Mechanical verification first**, before any model opinion.
2. **Independent semantic review** by a different model than the writer, given the spec, task contract, diff and test evidence, never the writer's reasoning.
3. **Repair loop.** A failed review becomes a machine-generated repair brief (criterion, finding, evidence, required repair, allowed scope). Worker repairs, mechanical tests re-run, reviewer re-checks, up to a policy limit. Only repeated failure or genuine ambiguity reaches a human.
4. **Spec verifier.** Builds a criterion-by-evidence matrix; a criterion with no evidence triggers repair or test generation.
5. **Adversarial review.** For the appropriate risk class, a fresh model receives the integrated candidate and is instructed to assume it is wrong.
6. **Integration.** Task success is not integration success; the full gate suite runs again on the combined candidate.

**Review quorum scales with risk:** low (worker + mechanical gates + lightweight review), medium (+ different-model reviewer), high (+ targeted experiments + semantic adjudication), critical (+ second reviewer, recovery proof, staging rehearsal, human irreversible gate).

## Run state

```
runs/<SPEC-ID>/
  run.json  plan.json
  tasks/    results/   reviews/   evidence/
  claims/ledger.json   disagreements/   logs/events.jsonl
```

**Recovery requirement:** after a restart, `resume <SPEC-ID>` must reconstruct the run from durable state and the event ledger, without depending on any previous model session.

## Autonomy ladder

- **A.** Autonomous through merge-ready; human merges and deploys.  ← v0.1 target
- **B.** Autonomous through staging; human deploys to production.
- **C.** Automatic production deploy for pre-approved low-risk classes.
- **D.** Automatic deploy with health checks and automatic rollback.

Autonomy is earned from measured runs: human interventions, repair loops, review defects, escaped defects, cost per run, acceptance pass rate. Critical migrations may permanently retain a human gate.

## v0.1 scope

Frozen spec → planner → 2–4 tasks → isolated worktrees → workers → mechanical gates → different-model review → automatic repair → integration → spec verification → `READY_FOR_HUMAN_MERGE`. No automated production deployment.

Success criterion: run it against three real features with the human performing only (1) freeze spec, (2) launch run, (3) receive the candidate or a genuine escalation.

## What produced these rules

Two migration investigations on a customised fork of an open-source LLM workflow platform. In each, one model researched and then ran repeated adversarial rounds on its own findings and delivered a polished report; an independent audit by a different model still found count errors, malformed structured artifacts, over-claimed sequencing and missing rollback steps. One report summed its own work packages to 85 and stated 84. The laws above are the generalisation of those failures.
