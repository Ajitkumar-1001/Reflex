# Reflex harness: Phase 0 foundation

Strict-TypeScript module with no Next.js imports; it only lives under `frontend/` to share the
existing pnpm package. Dependencies: `zod`, `vitest`. No environment variables are read, so there is no
`.env.example`.

**Source of truth: `Reflex_Engineering_PRD_v1.4.md`** (status: "proposed defaults pending owner confirmation").
Review rounds r1–r3 are folded into v1.4; `Reflex_PRD_review_r3.md` is the review of v1.4 itself (READY, no
blocker or high findings). Section numbers below (`§`) and decision ids (`DEC-nn`) are v1.4's.

This module is the **memory-disabled baseline** (arm A, FR-12). It calls no real model, tool process,
database or sandbox.

```
pnpm test        # contracts, admission, permission, tools, integrity, failures, exit gate, baseline
```

## What exists

| File | Purpose |
|---|---|
| `contracts.ts` | Zod schemas for the six collections' documents and the canonical contracts: `CreateTask`/`Task` (§15.2, §10), `Policy`, `Run`, `Event` (a discriminated union), `Evaluation`, `MemoryCandidate`/`MemoryRecord`, `Reflection`, `JudgeVerdict`, `GateDecision`; the run state machine (`TRANSITIONS`), the legal terminal state/outcome/reason triples (`TERMINAL_RESULTS`) and the memory lifecycle (`MEMORY_TRANSITIONS`) |
| `paths.ts` | `normalizePath`, scope check, and the §11 default protected paths |
| `admission.ts` | `createTask` (body → stored task; `forbidden_field` for identity in the body) and `admitTask` (task + pinned policy + registry; FR-01) |
| `ports.ts` | Interfaces where deferred decisions plug in (see Seams) |
| `permission.ts` | `ToolRegistry`, `authorizeToolCall`: default-deny; registered, side-effect class, policy allowlist, mode, argument schema, command allowlist, scope, protected paths |
| `adapters.ts` | The seven P0 stub tools, scripted model, in-memory workspace and artifact store, deterministic clock and ids |
| `evaluator.ts` | `CheckEvaluator` (verdict only from executed checks, hidden bundle, tamper detection) and `auditTrace` (re-derives the exit gate from the trace) |
| `runner.ts` | `ReferenceRunner implements RunEngine`: admission, retrieval skipped, plan, bounded tool loop, §7.8 retries and failure mapping, evaluation, reflection skipped |
| `recovery.ts` | `recoverInterruptedRun`: §7.8 last row |
| `fixture.ts` | The `fix-add-bug` fixture, its hidden check bundle, and `runFixture()` |
| `__snapshots__/baseline.memory-off.json` | Recorded arm A baseline; `baseline.test.ts` fails if it drifts |

## Phase 0 exit gate (§20)

"A deterministic task fixture runs with complete trace, clear failure states, and zero unauthorized tool
actions." `exit-gate.test.ts` proves each clause over a 14-scenario matrix (one per reachable terminal
outcome/reason) rather than the happy path alone:

1. **Complete trace**: `auditTrace` finds no problems (gapless sequence, legal transitions, ends terminal,
   every `tool_result` preceded by `tool_authorized`), and the run validates against `RunSchema`.
2. **Clear failure states**: each scenario ends in the exact §7.1 state/outcome/reason; `contracts.test.ts`
   pins `TERMINAL_RESULTS` to the §7.1 table.
3. **Zero unauthorized tool actions**: ten adversarial tool attempts are denied, recorded as `policy_denied`
   and never executed; `auditTrace` computes the count from the trace alone.
4. **Determinism and correlation**: repeat runs are byte-identical; every event links to its run and every
   run to its task (FR-02); versions and hashes are pinned (INV-05).

The recorded baseline snapshot was refreshed deliberately twice in this alignment (trace hash after
`run_command` replaced `run_check`; report shape after `ledger` became `steps` + `cost` and the evaluation
gained its integrity fields). The diff of each is in git history.

## §7.8 failure mapping (FR-30)

| Row | Status | Test |
|---|---|---|
| Provider 429/5xx/network: 3 retries, 2/8/30 s, jitter → `INCONCLUSIVE/model_unavailable` | implemented | `failures.test.ts` |
| Model call timeout (120 s): one retry → `INCONCLUSIVE/model_unavailable` | implemented | `failures.test.ts` |
| Malformed output: re-prompt once → `FAILED/malformed_model_output` | implemented | `runner.test.ts` |
| Unregistered tool / out-of-scope args: deny + `policy_denied` event, 3 denials → `BLOCKED/policy_denied` | implemented | `runner.test.ts`, `exit-gate.test.ts` |
| Tool timeout / non-zero exit → observation | implemented | `failures.test.ts` |
| Sandbox crash → `INCONCLUSIVE/infra_failure`, no retry | implemented against the `InfraFailureError` seam | `failures.test.ts` |
| Budget exhausted (stricter of task and policy) → `FAILED/budget_exhausted` | implemented (`step_limit` for steps) | `runner.test.ts` |
| Atlas unavailable during retrieval (`retrieval_degraded`) | not implemented: no retrieval, Phase 1 | |
| Atlas unavailable during persistence (JSONL spool) | not implemented: no Atlas, Phase 1 | |
| Reflector/judge unavailable (`judge_unavailable`) | not implemented: no reflector or judge, Phase 1 | |
| Process crash → `FAILED/internal_error` on startup | implemented as `recoverInterruptedRun` | `failures.test.ts` |

## Deviations from PRD v1.4

1. **`TRANSITIONS` is wider than §7.1's literal list.** §7.1 lists `ADMITTED → BLOCKED` and
   `EVALUATING → INCONCLUSIVE`, but §7.8 sends 3 policy denials (during `EXECUTING`) to `BLOCKED` and provider
   or sandbox failures (during `PLANNING`/`EXECUTING`) to `INCONCLUSIVE`, and §11 sends a plan needing an
   external write to `BLOCKED`. `PLANNING` and `EXECUTING` therefore may reach both. `RETRIEVING →
   INCONCLUSIVE` is not allowed, since §7.8 lets a failed retrieval continue.
2. **`Policy` gains `commandAllowlist`** (argv prefixes). §11 says `run_command` checks "the policy's command
   allowlist", but the §10 `policies` field list has no such field.
3. **Stub tool behaviour** (the schemas and limits are §11's): `search_code` matches `pattern` as a fixed
   string, not a ripgrep regex, so a model-chosen pattern cannot stall the orchestrator; `apply_patch`
   authorizes every path a diff names (including renames) but the in-memory workspace does not apply it.
   Both change when tools run in the sandbox (DEC-02).

## Readings of v1.4 text that is ambiguous (not decisions; listed so they can be overturned)

- The authorized tool set is the pinned policy's `toolAllowlist`: §7.2 lists "authorized tool set" among task
  fields but the §15.2 `CreateTask` schema has none, so the v1.0 `task.authorizedTools` is removed.
- Allowlist entries match by argv **prefix**, the only way to express both `npx tsc` and `git status` (§11
  says "`argv[0]` must be on the allowlist"). `node` allows arbitrary code in the sandbox, as §11 implies.
- §7.1 reason codes are labelled "Example"; they are treated as the closed set, plus §7.8's
  `INCONCLUSIVE/internal_error`.
- Hitting the step limit ends `FAILED/step_limit`; cost or wall-clock ends `FAILED/budget_exhausted`
  (§7.1 names both reasons; §7.8 files steps under budget).
- A plan or call naming a registered `external_write` tool ends `BLOCKED/approval_required_p0` whatever the
  policy lists. P0 registers none, so a plan naming an unregistered tool such as `git_push` ends
  `BLOCKED/policy_denied` instead: v1.4 does not say how a plan "requires" an unregistered capability.
- Stored task uses `requestedBy` (§10); §15.2's response type says `createdBy`.
- Only an `ACTIVE` policy admits a task, and a task's risk class may not exceed its policy's; v1.4 gives the
  policy `status` and `risk_class` fields but not these rules. `memoryRules` and `routingPreferences` shapes
  are not in v1.4 and are kept as before.
- The PRD's §12.1 exception ("unless the task explicitly authorizes test changes and a hidden check passes")
  has no task field, so every protected-path change is a tamper flag. Narrowed globs (§12.1's fourth example)
  have no static rule beyond the protected-path check.
- A hidden check bundle is honoured when the task names one; it is not required, because v1.4 does not say
  whether the Phase 0 fixture is a "suite task" (§12.1 vs §19). `checkBundleHash` covers the check
  definitions, not code, until checks run from a container image (DEC-02).
- Per-tool timeouts other than `run_command`'s, the jitter width (±25%), and what `read_file` does past 400
  lines or 64 KB (truncates, with a marker) are not specified.
- A procedural `MemoryCandidate` is rejected for `hypothesis` or `rejected` evidence only (INV-03: "an
  untested hypothesis is not a reusable procedure"). The v1.0-era code also rejected `inferred`; v1.4 does
  not say so, and whether an inferred lesson may become a procedure is the write gate's call (§9.3 check 2).
  Single-run confidence <= 0.5 (§9.3) is likewise gate behaviour, not a schema rule.
- An investigation run has no checks, so its evaluation is `inconclusive/missing_checks`; and `run_command`
  (a `workspace_write` tool) is unavailable to it.

## Non-durable by design

`ReferenceRunner` is a single-process in-memory executor. A crash loses the run; `recoverInterruptedRun`
only marks the leftover record. It is **not** the DEC-01 decision: v1.4's proposed default is a custom typed
state machine behind `RunEngine`, but that is pending owner confirmation, and a Mastra adapter would
implement the same interface.

## Seams and the v1.4 decisions they wait on

| Seam | Phase 0 stand-in | Blocked on |
|---|---|---|
| `RunEngine` | `ReferenceRunner` | DEC-01 (orchestrator) |
| `Workspace`, `CommandTable`, `InfraFailureError` | `InMemoryWorkspace`, scripted commands; no isolation claimed. Sandbox escape tests (§27) and checks run from a pinned image are not possible yet | DEC-02 (Docker sandbox) |
| `ModelAdapter` | `ScriptedModel`; `ModelUnavailableError` drives the §7.8 retries | DEC-10 (pinned models, spend); DEC-04 (repo privacy, `cloud_not_permitted`, never produced); DEC-12 (judge model) |
| `EventSink`, `ArtifactStore` | Optional callback; `InMemoryArtifactStore` keyed by sha256 | DEC-08 (six collections, Atlas `events`); DEC-05 (artifact and trace retention) |
| Durable queue, leases, resume | None; the runner is called directly | DEC-03 (BullMQ/Redis; Phase 2) |
| Memory retrieval, write gate, review queue, writeback | Disabled: `retrieval_skipped` and `reflection_skipped` events; plans may not cite memory (INV-02); policies enabling memory are blocked. Schemas (`MemoryRecord`, `GateDecision`, `JudgeVerdict`, `Reflection`) exist and nothing reads or writes them | Phase 1; DEC-05 (TTLs, review thresholds); DEC-12; DEC-13 (playbook scope) |
| Evaluation corpus and experiment runner | One fixture; no arms B/C, `experimentId`, `trialIndex`, `seed` | DEC-06 (lift threshold), DEC-11 (suite source; the M1 "20 generated tasks") |
| Cody / standalone integration | None. Standalone | DEC-07 |

DEC-09 (timeline) has no code. The v1.4 defaults for every DEC are proposals pending the owner's
confirmation, so none is built in.

Not implemented, and not stubbed: Atlas client, Redis/BullMQ, S3, OpenTelemetry SDK, the §15 API routes and
§17.0 roles/tokens (FR-29), redaction of event payloads (`argsSummary` is truncated but not scrubbed) and the
§9.3 secret scanner, a filesystem artifact store and the §27 environment configuration, the one-active-run
unique index (`409 run_active`), `reflexVersion` on runs, run `checkpoint`, memory tombstones, and P1's
`WAITING_APPROVAL` / `RETRY_PENDING` states.
