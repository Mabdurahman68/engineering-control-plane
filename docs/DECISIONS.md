# Decisions

Implementation decisions made during the v0.1 build, where the design left a choice or two design sections disagreed. Section numbers refer to the design package.

## Runtime dependencies

Only `zod` and `yaml`, as the build plan fixes.

## Order of work

M8 comes before M8P, and M10 before M10M, because rule removal has to cover everything else. M9I follows M9.

## Injection tests and relays

The launch-window and escaping-child tests need real pinned relays, so they land at M9. M9's gate runs all of `test/injection`.

## Verify on a reserved criterion

A `human_reserved` criterion may omit `verify`. Any other criterion with no `verify` fails validation.

## Unverifiable criteria

`covered(AC)` means `human_reserved`, or an in-force owner `mark_human_verified` decision. It's computed from the spec and the ledger.

- `UNVERIFIABLE` may sit in a `PASS` only if covered.
- An uncovered `UNVERIFIABLE` requires verdict `FAIL` and cites at least one blocker or major finding.
- **Extended linkage rule:** every blocker or major finding is cited by a failed criterion, a failed semantic check, or an uncovered `UNVERIFIABLE` criterion. This one extension to the consistency rules lets unavailable verification reach the owner without an invented semantic failure.
- A waiver can't clear an uncovered `UNVERIFIABLE`. Only `mark_human_verified` covers it.
- In an integrated review, if every blocking finding links only to uncovered `UNVERIFIABLE` criteria, the run escalates as `UNVERIFIABLE_CRITERION`. Task-level reviews take the normal `FAIL` path.

## Hard gates and policy

A policy file can't relax a hard gate or independence. Neither is read from policy.

## Who may raise risk

In v0.1, only the planner and diff detection raise risk after spec freeze. Reviewers have no field for it.

## Cancel and cleanup

Adapter cancel is always followed by the shared cleanup and the liveness check.

## Interrupted work

The re-attach-or-kill rule governs. Interrupted work is redispatched only after that rule's kill path.

## Conflicts at QUICK

The permitted conflict attempt is zero at QUICK and one otherwise.

## Gate predictions with no discriminator

A gate-failure prediction with null `failing_test` and null `error_contains` can reach `near_match` at most.

## Supervised runs and commits

The bar on branching and committing applies to workers. The coordinator commits.

## Real-worker restriction

No CLI executable runs, for any purpose, before the guard passes. All CLI execution goes through one function in `src/workers/relay/`. Fixtures are identified by location and SHA-256 only; no file authorises itself by its content. `BUILD_ALLOWS_REAL_WORKERS` is `false` in this build, so any non-fixture executable is refused whatever files exist. A later release must change code.

## M11 conditions, not built here

- How `ecp-proc spawn` obtains a trusted executable, argv, environment and paths.
- A launch-data handoff outside the run folder.
- Helper ownership and path-substitution protection.
- `kill-all` reaching read-only shadow processes of the same user. It needs a separate shadow user, or no shadow in flight during `kill-all`.

## `schema` on agent-written reports

Reports written by a model (`plan.v1`, `worker_report.v1`, `challenge.v1`, `review_report.v1`, `ruling.v1`, `shadow_report.v1`) may omit `schema`, because the contracts' own worked example does. Code knows which step it asked for. All other objects require it.
