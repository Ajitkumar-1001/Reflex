# Reflex harness: Phase 0 foundation

Strict-TypeScript module with no Next.js imports; it only lives under `frontend/` to share the
existing pnpm package. Dependencies: `zod`, `vitest`.

Spec: PRD v1.0 (§7.1, §10, §11, §12, §20 Phase 0). This module is the **memory-disabled baseline**
(arm A, FR-12). It calls no real model, tool, database or sandbox.

```
pnpm test        # contracts, permission, runner, trace audit, baseline
```

## What exists

| File | Purpose |
|---|---|
| `contracts.ts` | Zod schemas: task, run, event, evaluation, memory (candidate + record), policy, plan; the run state machine (`TRANSITIONS`) and the legal terminal state / outcome / reason triples |
| `ports.ts` | Interfaces where deferred decisions plug in (see Seams) |
| `permission.ts` | `ToolRegistry`, `authorizeToolCall`: default-deny; checks registered, task set, policy allowlist, side-effect class, argument schema, workspace scope and protected paths |
| `adapters.ts` | Scripted model, in-memory workspace, stub tools (`list_files`, `read_file`, `write_file`, `run_check`, `finish`), deterministic clock and ids |
| `evaluator.ts` | `CheckEvaluator` (verdict only from executable checks) and `auditTrace` (re-derives the exit gate from the trace) |
| `runner.ts` | `ReferenceRunner implements RunEngine`: admission, retrieval skipped, plan, bounded tool loop, evaluation, reflection skipped |
| `fixture.ts` | The `fix-add-bug` fixture and `runFixture()` |
| `__snapshots__/baseline.memory-off.json` | Recorded arm A baseline; `baseline.test.ts` fails if it drifts |

## Phase 0 exit gate

`runner.test.ts` and `baseline.test.ts` show that the fixture runs end to end with a complete trace
(gapless sequence, legal transitions, ends terminal), explicit failure states, and zero unauthorized tool
actions. Prohibited calls are denied, recorded as `policy_denied` events, and never executed.
`auditTrace` computes "unauthorized tool actions" from the trace alone: a `tool_result` with no
preceding `tool_authorized` event.

## Deviations from PRD v1.0 (all additive)

- `RunOutcome` includes `failed`, borrowed from v1.4, because v1.0 has a `FAILED` state but no outcome for it.
  Runs also carry an `outcomeReason`, and `TERMINAL_RESULTS` lists the legal state/outcome/reason triples
  (the reason names are from v1.4 §7.1 and §7.8).
- A run ends `BLOCKED / policy_denied` after 3 policy denials, and `FAILED / step_limit` or `budget_exhausted`
  on budget limits (v1.4 §7.8).
- `BLOCKED` and `INCONCLUSIVE` are reachable from more states than v1.0 §7.1 lists, so policy and model
  failures during planning or execution end in an honest terminal state.
- Memory records use v1.0's `status` field. Its values are not enumerated in v1.0, so `candidate | approved |
  rejected | expired | retired` is an assumption.
- Risk classes `low | medium | high` are an assumption; v1.0 names the field but not the values.

## Non-durable by design

`ReferenceRunner` is a single-process in-memory executor. A crash loses the run; nothing resumes it, nothing
is crash-safe, and no tool timeout is enforced (the stub tools are synchronous). It exists as the Phase 0
baseline. It is **not** the DEC-01 decision: a custom state machine or a Mastra adapter would both implement
`RunEngine` and replace it.

## Seams and the decisions they wait on

| Seam | Phase 0 stand-in | Blocked on |
|---|---|---|
| `RunEngine` | `ReferenceRunner` | DEC-01 (custom state machine vs Mastra adapter) |
| `Workspace` | `InMemoryWorkspace`; no isolation claimed | DEC-02 (container vs local worktree, network access) |
| `ModelAdapter` | `ScriptedModel`; provider outages surface as `ModelUnavailableError`, with no retry or backoff | DEC-04 (repository privacy tiers, cloud vs local-only models) |
| `EventSink` | Optional callback; the run also returns its events | Atlas `events` collection (Phase 1), OpenTelemetry (not a DEC); retention in DEC-05 |
| Durable queue, leases, resume | None. The runner is called directly | DEC-03; Phase 2 |
| Memory retrieval, write gate, writeback | Disabled: `retrieval_skipped` and `reflection_skipped` events, plans may not cite memory (INV-02), policies enabling memory are blocked. Schemas exist; nothing reads or writes them | Phase 1; DEC-05 (retention, TTLs, review thresholds) |
| Artifact storage (object store) | None. Events carry short summaries only | Phase 1+; DEC-05 (retention) |
| Evaluation corpus | One fixture | DEC-06 (canonical suite, meaning of improvement) |
| Cody / standalone integration | None. Standalone | DEC-07 |

Not implemented, and not stubbed: Atlas client, Redis/BullMQ, S3, OpenTelemetry SDK, redaction of event
payloads (`argsSummary` is truncated but not scrubbed), and the PRD's WAITING_APPROVAL / RETRY_PENDING states (P1).

No environment variables are read, so there is no `.env.example`.
