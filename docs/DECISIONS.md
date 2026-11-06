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

## Snapshot intent

The frozen event list has no `snapshot.intent`. The finished, unclassified attempt is the durable intent: a crash redoes the snapshot idempotently on the untouched tree, because no attempt can start until this one is classified.

## What logical steering invariance compares

AC-I compares ordered event content. It leaves out `shadow.*`, and the ledger envelope (`seq`, `prev`, `hash`, `at`). It also leaves out what the clock or the OS supplies and steers nothing: `heartbeat`, `host.sleep_detected`, and process IDs and start times. `decision.made` stays in.

## When the run waits for shadow proposals

Only when a run finishes. A pause or escalation doesn't wait: the wait would let the shadow move time, and `onResume` settles anything left open.

## Push gate on a merge's content

The history scan works from each commit's whole tree, not from diffs, so content from a merge resolution can't be missed. The name scan also covers paths and commit metadata.

## A pause isn't a stop for shadow proposals

A paused run leaves proposals outstanding, to settle on resume.

## Where the fake-actor proof goes

Architecture §6 saves the isolation proof as `docs/isolation-proof.json`. That's for the dedicated machine, where it's real evidence. A fake-actor proof from this build goes to `$ECP_HOME/isolation-proof.json`, so it can't be read as evidence about this repository.

## An API key is never the next step down

Nothing enforced AC-K until M10M, because the default rungs are all subscriptions. Now, once a subscription rung is quarantined for quota or auth, API-key rungs are barred for the rest of that quarantine. An API-key rung the owner put first still runs. A subscription rung is never handed a credential, whatever `credential_env` says.

## A cancelled run doesn't wait for shadow proposals

The end-of-run wait exists to let proposals finish. An operator's cancel means stop, so unfinished proposals are stopped and marked unavailable at once. A proposal given up on, for any reason, has its process stopped: marking it unavailable isn't enough.

## `ecp-proc` isn't wired into the engine

The coordinator's side of the helper is built and tested against a fake, as the binding table asks. Nothing calls it at run time in this build, because no second user exists to control. M11 wires it, with the conditions recorded above.

## Real-worker guard, beyond the plan's wording

A symlink from elsewhere into the fixture directory is refused too, even though it resolves to a pinned file: its launcher would run whatever core sits beside the link. A `PATH` with an empty or relative entry before the match is refused, since the first match can't be known from another directory.

**Residual limit:** the launchers call `node` by name, so a `node` earlier on `PATH` would run instead of the pinned one. The guard doesn't check it. No untrusted actor runs on this machine in this build.

## The coordinator lock

A directory of numbered claims. The owner is the highest claim whose process is alive. A takeover claims the next number with a link, which either creates it or fails, and a claimant that then isn't highest gives up. Nobody removes or replaces a claim that could be someone's, so no age check is involved. The argument is in `src/cli/lock.ts`.

Liveness has three answers. Dead needs evidence: `kill(pid, 0)` giving `ESRCH`, or the PID now belonging to a later process. A process's identity is one a clock change can't move. On Linux, `lstart` is boot time plus ticks, and boot time shifts when the wall clock is set, so the identity is the boot ID and the start ticks from `/proc`. On macOS, it's the start time the kernel records once at process start, read with `ps` under a fixed time zone and locale, which has to parse as a real time. Elsewhere there's none, and only `ESRCH` shows an owner gone. Anything that can't be read, or doesn't compare, isn't evidence. Anything else is unknown, and an owner isn't unseated on unknown. So a machine where `ps` is broken refuses to start a run, rather than risk two.

## Evidence for a semantic claim

`claims_reviewed` has no evidence field, and contracts §5 fixes its shape. A PASS on a `FACT`, `BEHAVIOUR` or `ARCHITECTURE` claim needs a reference inside `reason`: a path, a path and line, or a 40-hex ID. Code checks the form and not the truth, which stays with the independent reviewer.

## How AC-A was shown

`pnpm check` under `env -i`, an empty HOME and `sandbox-exec` denying IP. macOS won't exec setuid `ps` in a sandbox, so for that run a shim asks a helper outside it to run `/bin/ps`, and nothing else. The shim and helper aren't in the repository. `ECP_TEST_PATH_PREFIX` exists for them.

## What the hole test asserts ran

AC-B says every behaviour at every step. The hole test records what actually ran, and at 5,000 runs or more fails on any pair that didn't. Shadow behaviours, including every failure any step can have, are asserted to run by the invariance suite. Challenge, adjudication and the conflict resolver need a set-up run, so the fuzz stages those.
