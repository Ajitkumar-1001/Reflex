# Reflex harness: Phase 0 foundation and Phase 1 experience layer

Strict-TypeScript module with no Next.js imports; it only lives under `frontend/` to share the
existing pnpm package. Dependencies: `zod`, `vitest`. No environment variables are read, so there is no
`.env.example`.

**Source of truth: `Reflex_Engineering_PRD_v1.4.md`** (status: "proposed defaults pending owner confirmation").
Review rounds r1–r3 are folded into v1.4; `Reflex_PRD_review_r3.md` is the review of v1.4 itself (READY, no
blocker or high findings). Section numbers below (`§`) and decision ids (`DEC-nn`) are v1.4's.

Without a memory runtime this module is the **memory-disabled baseline** (arm A, FR-12); with one, and a policy
that enables it, the same runner is the **memory-on arm** (B). It calls no real model, tool process, database,
embedding service or sandbox: every one of those is behind a port, and the stand-ins are deterministic.

```
pnpm test        # Phase 0: contracts, admission, permission, tools, integrity, failures, exit gate, baseline
                 # Phase 1: store, retrieval, gate, lifecycle, memory runner, experiment, explorer, exit gate
```

Phase 1 is described from "Phase 1 (§20)" below; everything above that heading is unchanged Phase 0 text except
where a sentence became untrue and was corrected.

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
| `runner.ts` | `ReferenceRunner implements RunEngine`: admission, retrieval (skipped, or hybrid when a memory runtime is wired and the policy enables it), plan, bounded tool loop, §7.8 retries and failure mapping, evaluation, reflection and gated writeback (skipped, or on a non-test split) |
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
| Atlas unavailable during retrieval (`retrieval_degraded`) | implemented (Phase 1): run continues memory-less, tagged `degraded`, excluded from A/B statistics | `memory-runner.test.ts`, `experiment.test.ts` |
| Atlas unavailable during persistence: 3 retries, spool, `INCONCLUSIVE/internal_error` | retries and the terminal state implemented; the spool is the `EventSink` seam, and replay on startup is not built | `memory-runner.test.ts` |
| Reflector/judge unavailable | implemented (Phase 1): outcome stands; reflector down writes only the episodic record; judge down gives `REVIEW_REQUIRED / judge_unavailable` | `memory-runner.test.ts`, `gate.test.ts` |
| Malformed reflection: re-prompt once, then `FAILED/malformed_model_output` | implemented (Phase 1), see the reading below | `memory-runner.test.ts` |
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

## Non-durable unless a worker is driving it

`ReferenceRunner` on its own is a single-process executor. A crash loses the run; `recoverInterruptedRun`
only marks the leftover record. Pass `deps.execution` (see Phase 2 below) and the same loop checkpoints each
completed step and can resume it. It is **not** the DEC-01 decision: v1.4's proposed default is a custom typed
state machine behind `RunEngine`, but that is pending owner confirmation, and a Mastra adapter would
implement the same interface.

## Seams and the v1.4 decisions they wait on

| Seam | Phase 0 stand-in | Blocked on |
|---|---|---|
| `RunEngine` | `ReferenceRunner` | DEC-01 (orchestrator) |
| `Workspace`, `CommandTable`, `InfraFailureError` | `InMemoryWorkspace`, scripted commands; no isolation claimed. Sandbox escape tests (§27) and checks run from a pinned image are not possible yet | DEC-02 (Docker sandbox) |
| `ModelAdapter` | `ScriptedModel`; `ModelUnavailableError` drives the §7.8 retries | DEC-10 (pinned models, spend); DEC-04 (repo privacy, `cloud_not_permitted`, never produced); DEC-12 (judge model) |
| `EventSink`, `ArtifactStore` | Optional callback; `InMemoryArtifactStore` keyed by sha256 | DEC-08 (six collections, Atlas `events`); DEC-05 (artifact and trace retention) |
| Durable queue, leases, resume | `execution/`: `JobQueue` plus an in-memory adapter, per-step checkpoints, worker leases. No BullMQ or Redis client | DEC-03 (a BullMQ/Redis adapter is still the open choice; the interface is what it would implement) |
| Memory layer | Phase 1, see "Phase 1 seams" below | DEC-05, DEC-06, DEC-08, DEC-10, DEC-11, DEC-12, DEC-13 |
| Cody / standalone integration | None. Standalone | DEC-07 |

DEC-09 (timeline) has no code. The v1.4 defaults for every DEC are proposals pending the owner's
confirmation, so none is built in.

Not implemented, and not stubbed: Atlas client, Redis/BullMQ, S3, OpenTelemetry SDK, the §15 API routes and
§17.0 tokens and authentication (FR-29; the role matrix itself exists as `access.ts`), redaction of tool-call
`argsSummary` and plan text in events (they are truncated but not scrubbed; reflections and stored memories are
scanned and redacted, see Phase 1), a filesystem artifact store and the §27 environment configuration, the
one-active-run unique index (`409 run_active`), `reflexVersion` on runs, and P1's
`WAITING_APPROVAL` / `RETRY_PENDING` states. Per-step checkpoints for a run that went through the Phase 2
worker are described below; `recoverInterruptedRun` is still what a bare `ReferenceRunner` gets.

---

# Phase 1 (§20): the Atlas experience layer, on ports

PRD §20 asks for "the six collections and indexes, episodic/semantic/procedural memory schemas, hybrid retrieval,
bounded context injection, structured evaluator/reflection, gated writeback, and memory explorer". Everything
below is built against in-memory or deterministic stand-ins behind ports, because the decisions that choose the
real components are open (DEC-08 Atlas, DEC-10 models, DEC-12 judge) and are not made here. **No new
dependency was added**; the ones a real implementation needs are listed under "Dependencies a real Phase 1 needs".

## What Phase 1 adds

| File | Purpose | PRD |
|---|---|---|
| `store.ts` | `InMemoryStore`: the six collections with the §10 unique indexes (`(run_id, sequence)`, `(experiment_id, config_arm, task_id, trial_index)`, `(policy_id, version)`), the `(tenant, project, state, kind)` memory pre-filter, copies in and out, and `FrozenMemoryRepository` (reads pass, writes throw) | §10, FR-28 |
| `ports.ts` (additions) | `MemoryRepository`, `RunRecords`, `Embedder`, `Reflector`, `MemoryJudge`, `MemoryCard`, and the typed outages (`RepositoryUnavailableError`, `EmbedderUnavailableError`, `ReflectorUnavailableError`, `JudgeUnavailableError`, `StaleVersionError`, `FrozenMemoryError`) | §7.8, §9 |
| `embedder.ts`, `text.ts` | `HashingEmbedder` (word and character-trigram feature hashing, unit vectors, pins `stub-hashing-embedder` / `1`), tokenizer that keeps identifiers whole (`gen:client`, `src/add.ts`) and splits them | §9.2 |
| `retrieval.ts` | `HybridRetriever`: filter first, then BM25 and vector scores, weighted RRF with the Atlas constant 60, rerank on verified usefulness, recency, scope match and light confidence, relevance threshold (empty is valid), card and token caps, delimited untrusted-advisory block, per-card provenance, `search` for the explorer | §7.3, §9.2, §17.1, FR-03/04/22 |
| `scanner.ts` | Secret and PII scan (patterns plus entropy, base64 that decodes to text is routed to review not secret) and the instruction-elevation deny-list, both after §9.3 normalization (zero-width and bidi stripped, HTML comments and base64 blobs > 40 characters decoded; their presence alone is a finding) | §9.3, §17.1 |
| `gate.ts` | `WriteGate`: provenance and evidence-pointer resolution, eligibility by run outcome, truth status, scope, secrets, instruction elevation, genericity, dedup and contradiction, fail-closed judge, per-kind review policy; a closed set of reason codes; strictest result wins | §9.3, §7.1, FR-10/25, INV-01/02/03/08 |
| `reflection.ts` | `ScriptedReflector`, `RuleJudge` (stand-ins), `parseReflection` (a reflection that disagrees with the evaluator is invalid), the automatic episodic candidate, reflection-to-candidate mapping, `redactReflection` | §12, §12.2, FR-09 |
| `writeback.ts` | `MemoryWriteback`: APPROVE stores approved (or merges evidence into a near-duplicate), REVIEW_REQUIRED stores a `candidate`, REJECT stores a `rejected` record for audit; a secret-bearing candidate is stored redacted | §7.7 |
| `memory-service.ts` | `MemoryService`: conditional-update transitions on `(id, version)` (`invalid_transition` for the loser), owner-only decisions, quarantine by memory/run/task/time range with `dryRun` and transitive derived memories, un-quarantine, expiry, re-verification, supersession, retirement, use-feedback with counters, independent-confirmation confidence and net-harm demotion, capacity | §9.5, §9.6, FR-22/23/26 |
| `access.ts` | The §17.0 role matrix as a server-side `authorize(principal, action, resource)`; another project or tenant is `not_found`, a role lacking the action is `forbidden` | §17.0, FR-29 (matrix only) |
| `retention.ts` | `RetentionConfig` / `PROPOSED_RETENTION`: TTLs, idle window, confidence cap and step, demotion threshold, capacity, all injected | §9.3, §9.5, §9.6, DEC-05 |
| `live-records.ts` | Read overlay so the gate can check provenance of the run that is still executing | §9.3 |
| `runner.ts` (additions) | `MemoryRuntime`; arm B retrieval before planning; INV-02 citation check; one `memory_use` event per injected card; reflection and gated writeback in `REFLECTING`; frozen test split; `retrieval_degraded`; persistence retries | §7.1, §7.8, FR-27/28 |
| `experiment.ts` | `runExperiment`: interleaved A/B cells, k trials, pass^1 / pass^k / majority, exact McNemar, seeded bootstrap CI, exclusions, run-budget stops, frozen-arm write counter, descriptive per-memory effect | §12.3, FR-12/28, US-4 |
| `explorer.ts` | `MemoryExplorer`: `search`, `get`, `reviewQueue` (cursor-paginated), `runMemory`, typed and role-checked. No page, see below | §16, §15, US-2/3 |
| `memory-fixture.ts` | The Phase 1 lab: operator-swap tasks, `LessonFollowingModel` (applies a lesson when shown one), `lessonReflector`, seeding helpers | §19 |

## Phase 1 exit gate (§20)

"A failed run can produce a validated lesson, a later eligible task can retrieve it, and the fixed paired
evaluation can assess its effect. Unverified, stale, and cross-scope memories are excluded."
`phase1-exit-gate.test.ts` proves each clause through the whole path, not a component:

1. **Validated lesson from a failed run.** A `verified_failure` run is reflected on; the reflection is
   schema-validated and its evidence pointers resolve; the gate holds the lesson for a human (MVP default) and
   approves only the automatic episodic record; the owner's approval is attributed and audited. Seeded-secret,
   poisoned-README, fabricated-evidence and hidden-zero-width candidates never become `approved`, even with
   procedural auto-approval switched on. A `FAILED/step_limit` run reflects on nothing.
2. **Later eligible task retrieves it.** The candidate is invisible until approved; afterwards a related task
   injects it with rank, index and embedding versions pinned on the run, cites it in the plan, and the explorer
   traces it back to the source run and evaluation. An ineligible task (other project, other task class) does
   not retrieve it. Quarantining the source run removes it from the next retrieval; restoring brings it back.
3. **Paired evaluation reports the effect.** On the same six held-out tasks × 3 trials, arm B with the lesson
   still a candidate shows no lift (p = 1); after approval it shows a full lift (CI [1, 1], exact McNemar
   p = 2/64), with arm B frozen (0 writes). The report is reproducible: a fresh lab gives an equal report.
4. **Unverified, stale and cross-scope excluded.** For 13 probe memories (seven non-approved lifecycle states;
   past expiry, violated precondition, idle episodic; another project, another tenant, another task class) a
   matching control is injected and the probe never is, in the run's `memoryContext`.

**What this does and does not show.** The model is a test double that applies a lesson when it is shown one.
The tests prove that retrieval, injection, the gate, review, freezing and the statistics are wired correctly
and that the safety properties hold. They say nothing about whether a real model, a real embedding model or a
real task suite produces lift; that is the §12.3 experiment (DEC-06 threshold, DEC-10 models, DEC-11 suite),
and its n = 90 / 60 requirement is not met by six synthetic tasks. The lift numbers above are for the stub.

The suite was also mutation-checked by hand: removing each of sixteen safety rules (the approved-only filter, the
expiry, quarantined-source, precondition, scope and tenant checks, the secret and instruction scans, evidence
resolution, run-outcome eligibility, the INV-02 citation check, the frozen split, the quarantined-approval
guard, the owner-only decision rule, and secret redaction in stored memory and in the trace) made at least one
test fail. One survivor, the retriever's quarantined-source check, gained its own test.

## Phase 1 seams and the v1.4 decisions they wait on

| Seam | Phase 1 stand-in | Blocked on |
|---|---|---|
| `MemoryRepository`, `RunRecords`, `InMemoryStore` | In-process maps; unique indexes enforced in code; copy on read and write. Atlas collections, JSON-schema validators, migrations, the Atlas vector and lexical search indexes and `$rankFusion` are not built | DEC-08 (six collections on Atlas) and the `mongodb` driver |
| `Embedder` | `HashingEmbedder`: surface similarity only | DEC-10 (pinned embedding model; re-embedding means a new `indexVersion`, §9.2) |
| `HybridRetriever` | In-process BM25, vector, RRF (k = 60), rerank. `minCoverage`, `minCosine`, rerank weights and `recencyHalfLifeDays` are stand-ins: v1.4 requires a threshold but gives no values | DEC-08 and DEC-10 for the Atlas path; calibration needs the annotated retrieval set behind the §18 precision@5 target (DEC-11) |
| `RetentionConfig` | `PROPOSED_RETENTION`: TTL 90 d procedural / 180 d semantic, episodic idle 180 d, single-run confidence cap 0.5, demotion at 3 net-harmful runs, 2,000 per project. Auto-approval is `policy.memoryRules.autoApprove`, default `["episodic"]` | DEC-05 (retention, review thresholds, review SLA). The review backlog alert (> 3 days) is not built |
| `Reflector` | `ScriptedReflector` | DEC-12 (reflector and judge models); DEC-10 (executor); DEC-04 (cloud permission, `cloud_not_permitted` is still never produced) |
| `MemoryJudge` | `RuleJudge` (shared-term support check, deny-list for instruction-like). Not a claim-verifier | DEC-12 |
| Roles and identity | `access.ts` matrix, owner-only decisions and quarantine, project scoping. No tokens, hashing, expiry or revocation; `cody-service` "own tasks only" is not modelled | §17.0 is a proposed default (no DEC id); token storage as `policies` documents needs DEC-08; Cody adapter is DEC-07 |
| `ExperimentInput.runOne`, `runExperiment` | Orders cells and computes statistics; the caller builds each arm's runner | DEC-06 (the lift target: `meetsTarget` stays `null` until `targetLift` is supplied), DEC-10 (spend, pinned snapshot), DEC-11 (the 150-task suite and its splits) |
| Playbook (`playbook_item`) | Schema only. The gate always sends a playbook delta to review and the retriever never injects one | DEC-13 (playbook scope); delta curation, versioning and `playbook_version` pinning (FR-21) are not built |
| Memory explorer | Typed API (`explorer.ts`), no page | Not a DEC: a page needs the §15 routes and §17.0 authentication to be real, and over the non-durable in-process store (DEC-08) it would show an empty or demo-only list. No dependency would be needed |
| Persistence spool, traces | `EventSink` is the spool seam; replay on startup is not built. OpenTelemetry spans (§17.2) are not emitted | DEC-08 (where events live), DEC-05 (trace retention); needs the OTel SDK |

## Deviations from PRD v1.4 added in Phase 1

1. **`TRANSITIONS` gains `REFLECTING → INCONCLUSIVE`**, which §7.8 needs for "Atlas unavailable during
   persistence → `INCONCLUSIVE`" and §7.1's literal list does not contain.
2. **`MemoryRecord` gains `createdAt`, `updatedAt`, `lastUsedAt`, `scope.taskClass` and `scope.exclusions`.**
   §10 indexes on `updated_at` and §9.6 retires episodic records by idle time, but the field list has neither;
   §7.3 filters on task type, which needs somewhere to live; the reflection's `does_not_apply_when` (§12) would
   otherwise be dropped. `MemoryCandidate` gains optional `preconditions` and `applicability.taskClass`.
3. **`Policy.memoryRules` gains optional `maxCards`, `maxContextTokens`, `autoApprove`** (§9.2 says the caps are
   policy configuration). Absent values fall back to v1.4's proposed defaults at the point of use, so Phase 0
   policies still parse.
4. **`Run.retrievalSnapshot` is `disabled | hybrid | degraded`**, and `Run` gains optional `experimentId` and
   `trialIndex` (§10). The `disabled` shape and the memory-off trace are byte-identical to Phase 0
   (`baseline.test.ts` and its recorded snapshot are untouched).
5. **New event variants** (additive): `retrieval_recorded`, `retrieval_degraded`, `reflection_recorded`,
   `reflection_failed`, `writeback_blocked`, `memory_lifecycle`, `quarantine_recorded`; `reflection_skipped`
   accepts two more reasons and `model_output_invalid` a `reflection` stage. v1.4 names only `memory_use`,
   `gate_decision` and `evaluator_tamper_flag`.
6. **`RunRecords.memoryEvents`** is the §10 "partial index on events for `type = memory_use` by `memory_id`",
   widened to `memory_lifecycle` so the explorer can show an audit history.
7. **The quarantine time-range selector takes a `projectId`.** §15.2's `Quarantine` type has none because the
   project is derived from the token, which does not exist yet.
8. **Arms differ by the policy version a task copy pins.** A task pins `policyId/version` (Phase 0), so the same
   task is stored once per arm with different pins. The arms are otherwise identical.

## Readings of v1.4 text that is ambiguous in Phase 1 (not decisions; listed so they can be overturned)

- **A lesson generalizes a run's evidence, so it is `inferred`**, and the gate sends any `inferred`
  semantic/procedural candidate to review (§9.3 check 2, INV-03). This settles the Phase 0 question of whether an
  inferred lesson may become a procedure: it may, after a human. Only an episodic record, or a duplicate of an
  already approved memory, is exempt. Auto-approval defaults to episodic only; semantic is reviewed too, because
  §9.3 names only episodic as auto-approvable. A reflection with `requires_review` is always reviewed.
- **Malformed reflection stops the run.** §7.8's third row lists "reflection fails Zod" with a second failure
  ending `FAILED / malformed_model_output`, even though the evaluation already verified the outcome. That is
  implemented literally, including a reflection whose `outcome` contradicts the evaluator. The other reading
  (the verified outcome stands) is also defensible and would be a one-line change.
- **Reflector unavailable: outcome stands, only the episodic record is written.** No reflection is attempted on
  a `test`-split task (§12.3: memory frozen, writeback disabled). With a frozen repository on another split the
  reflector still runs and the first write is refused with `writeback_blocked`, so that case spends reflection
  tokens for nothing; the experiment harness avoids it by using `test`-split tasks.
- **Near-duplicate merge** adds `sourceRunIds`/`evaluationIds` to the existing memory as a new version, leaves
  its confidence alone, and needs no human. Polarity vetoes a merge: the tokenizer drops "not", so "use X" and
  "do not use X" overlap completely, and a test found that gap. A reversed polarity with high overlap is a
  possible contradiction → review.
- **Confidence** rises only on `helped` feedback from a task other than the memory's own source tasks
  (§9.3), by `confidenceStep` (0.1, not specified). Demotion needs `harmfulCount` ≥ 3 and > `helpfulCount`
  (§9.5 states this for the playbook; applied to every memory).
- **Run-time `memory_use` events are `followed: false, outcomeEffect: "unknown"`.** One run cannot tell whether
  a card was followed or whether it helped; `recordFeedback` and the paired evaluation answer that. Retrieval
  does not write `lastUsedAt`, so the frozen arm stays read-only; only feedback does, which means an episodic
  record that is injected but never given feedback still goes idle.
- **Quarantine blocks candidates through their source run**, not by state: `MEMORY_TRANSITIONS` has no
  `candidate → quarantined`, and §9.6 says such a candidate "cannot be approved".
- **Quarantine, restore and lifecycle audit events are stamped on the memory's first source run's trace**, so the
  six-collection model (DEC-08) is preserved; a memory whose source run was never recorded gets no audit event.
- **The retrieval query is the task objective plus its task class**; `stack`, `environment` and `toolVersions`
  filters exist but the runner has no source for them yet. `path:<file>` is the only precondition form the
  runner can evaluate; other preconditions are assumed to hold.
- **§7.3 "confidentiality" cannot be filtered**: no memory field carries it.
- **Primary endpoint.** The lift, bootstrap CI and McNemar test use the per-task majority-of-k outcome (§12.3
  step 5, §18). pass^1 is reported as the mean per-task trial success rate, pass^k as the share of tasks where
  all k succeed. §12.3 step 4 says "McNemar on pass^1"; that is not a binary per-task quantity.
- **Exclusions.** A task is dropped from the statistics, and listed with a reason, if any of its runs is
  `retrieval_degraded`, `infra_failure` or `model_unavailable`. Tamper, step-limit and blocked outcomes count as
  failures. A run-budget stop leaves only complete pairs.

## Deferred, with what blocks it

| Not built | Why |
|---|---|
| Atlas client, indexes, migrations, `$rankFusion` | DEC-08 and a `mongodb` dependency |
| Real embedding, reflector, judge, executor models | DEC-10, DEC-12, DEC-04 |
| Playbook deltas, versions, pinning, rollback (FR-21; DoD 11) | DEC-13 |
| The 150-task suite, the 90-task test set, the §12.3 report | DEC-11, DEC-06, DEC-10 |
| Arm B′ (online writeback during test), arm C, leave-one-out attribution (§12.3 step 6), order sensitivity (7), contamination dedupe (8), the §12.4 regression gate | The suite (DEC-11). B′ also has no value in `Run.configArm` (`A | B | C`) |
| HTTP routes, idempotency keys, tokens, rate limits, `409 run_active` | §15 and §17.0 are proposed defaults. Dispatch idempotency lives on `JobQueue`; the HTTP active-run index does not |
| Review-queue SLA alert, batch decisions | DEC-05 |
| Retrieval anomaly alert for trigger-keyed poisoning (§17.1), the other §17.2 alerts, OTel spans | Needs the OTel SDK and DEC-08 |
| Tombstones for deleted memories, consolidation (FR-20) | Deletion semantics belong with the store (DEC-08); consolidation is P2 |
| A memory explorer page | See the seam table: it needs routes and authentication to be more than a demo |

## Dependencies a real Phase 1 needs (none added)

`mongodb` (DEC-08), an embedding provider SDK (DEC-10), a model provider SDK for the executor, reflector and
judge (DEC-10, DEC-12), `@opentelemetry/*` (§17.2). A BullMQ/Redis adapter for `JobQueue` is still Phase 2's
open DEC-03; the in-memory adapter does not add `bullmq` or `ioredis`.

---

# Phase 2 workstream A: hardened execution

One dispatch is one job. `DurableExecutor` leases it and calls the same `ReferenceRunner`, memory-on or
memory-off. The in-memory `JobQueue` is the only adapter. DEC-03 (BullMQ/Redis) stays open, so `bullmq` and
`ioredis` are not dependencies.

| Piece | Behaviour |
|---|---|
| `enqueue` | Same idempotency key returns the original job, including when it is leased, acked, or dead. A second dispatch does not start a second run |
| `lease` | One holder. The critical section does not await, so two overlapping leases cannot both take the job. `leaseCount` increments; the job record is not copied |
| `heartbeat` | Extends `expiresAt` while the token is still active. A stale token raises `LeaseLostError` |
| `ack` | Completes the job. A repeat ack with the same token is a no-op |
| `nack` | Counts a failed attempt, waits out `backoffMs`, and dead-letters at `maxAttempts` (default 3). `exponentialBackoff` doubles from 1s and caps at 30s |
| Expired lease | Counts as a failed attempt and re-queues the same job immediately. At `maxAttempts` the job is dead-lettered instead of re-leased |
| Checkpoints | Written after the plan is committed, after each tool step (including a denial), after evaluation, and when the run is terminal. A crash mid-step leaves the previous snapshot; the partial workspace write is discarded |
| Resume | The next attempt restores the run, the trace, id counters, and the stepping clock, and continues at the next step. A terminal checkpoint is returned and not executed again, so a lost ack does not repeat side effects |
| Cancel | `cancel(dispatchId)` is read at the next step boundary (also before evaluation and reflection). The run stops `CANCELLED` / `cancelled` / `user_cancel`. The in-flight step is allowed to finish |

Cancellation uses the existing state machine. The status is `CANCELLED`; the outcome is `cancelled`. No new state was added (`WAITING_APPROVAL` and `RETRY_PENDING` stay absent).

A crash during `REFLECTING` resumes at the post-evaluation checkpoint, so reflection runs again. Memory rows already inserted by that attempt are not part of the checkpoint (the memory store is the Phase 1 repository). Artifact blobs are not in the checkpoint either; retention of traces and artifacts is the other Phase 2 workstream. The `409 run_active` index is still not built. `recoverInterruptedRun` is unchanged and still marks a bare, non-leased run `FAILED/internal_error`.
