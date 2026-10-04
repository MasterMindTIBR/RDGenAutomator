# Same Page Meeting — RDGen improvements

## Round 1
### Integrator findings (Codex, verbatim)
- [FIX] The current provider only trusts the `github.com` hostname, so “allowlisted” does not prevent unrelated repository/run URLs -> Restrict parsing to the exact RDGen repository, Actions path, and numeric run ID.
- [FIX] Existing worker polling only calls RDGen, so persisted GitHub telemetry will never become current -> Poll GitHub run/jobs data from the leased worker before scheduling the next poll.
- [CLARIFY] The plan does not define durable cache keys, TTLs, or cross-worker rate limiting -> Specify shared run-ID caching, backoff, and stale-data behavior.
- [FIX] Fallback to RDGen without freshness metadata can present stale GitHub state as current -> Persist source, observed time, and fetch error, then render stale or unknown explicitly.
- [CLARIFY] “Step-completion percentage” is undefined for parallel jobs, skipped steps, missing jobs, and empty step lists -> Define and test a deterministic aggregation formula, returning unknown when it cannot be computed.
- [FIX] Broad step-name heuristics can classify an input or build failure as infrastructure failure and resubmit it -> Use a conservative allowlist of known RDGen job/step identifiers and treat ambiguity as terminal.
- [CLARIFY] The plan does not define behavior when multiple jobs fail or the GitHub jobs response is incomplete -> Require complete job data and default conservatively when any failure remains unclassified.
- [FIX] Existing `retry_count` and `MAX_RETRIES` count RDGen transport failures, not consecutive GitHub infrastructure failures -> Add a separate workflow-infrastructure counter with an explicit reset point.
- [FIX] Duplicate polling or lease recovery could classify one failed workflow twice unless retry creation is conditional -> Close the active attempt and enqueue its replacement in one guarded transaction, with a concurrency test.
- [CLARIFY] The plan does not say whether GitHub unavailability during a failed workflow permits automatic retry -> Default to no automatic retry and expose a bounded telemetry recheck state.
- [FIX] Current `retry_exhausted` loses the failed step and user-readable reason -> Persist a stable failure code plus sanitized reason and map it to a UI label.
- [FIX] Rock 1’s proof has no GitHub fixtures, migration execution, API projection test, or database-backed worker path -> Add run/jobs fixture tests and end-to-end persistence/projection proof.
- [FIX] The current request projection omits server, preset, and request-image data, so a client-only clone wizard lacks safe source data -> Add an authenticated server-side clone-source or clone endpoint returning only non-secret fields and copying assets.
- [CLARIFY] Cloning inherited branding images is not equivalent to cloning request overrides when branding later changes or retention expires -> Decide whether cloning snapshots effective assets or reuses current branding, and define expired-image behavior.
- [CLARIFY] Published requests are visible to audience users, but clone authorization and resulting visibility are unspecified -> Define who may clone and always create clones privately unless explicitly changed.
- [FIX] The current request detail projection omits `server_id`, so server metadata already renders as unavailable -> Include `serverId` and cover it with an API test.
- [FIX] Existing detail renders request and job UUIDs, so “without UUIDs” requires removing more than the summary identifier -> Remove every identifier display and assert the rendered output contains none.
- [KILL] Removing the existing warning for public RDGen/GitHub capability URLs weakens a security boundary without improving transparency -> Keep a concise disclosure in the destination dialog, or proxy the action through an authenticated boundary.
- [FIX] React Query currently does not refetch request details, so real workflow state remains stale until reload -> Add bounded polling/focus refetch that stops for terminal jobs.
- [FIX] Existing reduced-motion CSS does not disable Framer Motion inline animations -> Use Motion’s user-preference reduction support and test it.
- [FIX] Rock 2’s web proof has no detail, clone, status-dialog, or reduced-motion assertions -> Add component/browser tests against mocked API responses for every done condition.
- [CLARIFY] Company defaults need different validation and mapping for display name versus executable name, but fields and overwrite precedence are unspecified -> Define field names, constraints, and whether selection overwrites or only fills blank values.
- [CLARIFY] “Newest artifact per profile/platform” is ambiguous because one job can produce multiple installers and architectures -> Define ordering and whether history returns every format or one selected executable.
- [FIX] Company history needs an administrator-only projection, while the existing request/artifact endpoints have different authorization semantics -> Add a small `/admin/companies/:id` read endpoint reusing existing tables and download URLs, with admin-versus-user tests.
- [FIX] Company defaults must appear in both admin and request-options projections or the form will silently ignore them -> Update migration, schema, both API projections, UI mapping, create prefill, and clone tests together.
- [FIX] Rock 3’s proof cannot detect broken history queries, artifact selection, authorization, or downloads -> Add database/API integration coverage including retention and non-admin denial.
- [FIX] “All checkboxes” includes native inputs in forms, dialogs, and SweetAlert markup, while typecheck cannot validate visual states -> Centralize the checkbox primitive or global styling and test checked, unchecked, focus, and disabled states.
- [FIX] Rock 4’s typecheck-only proof cannot detect the old preset approval metadata remaining in the rendered UI -> Assert the rendered preset row shows version and connection direction.
- [CLARIFY] The claimed production cleanup has no migration, script, audit record, or repository evidence -> Provide transaction counts and postcondition evidence, or record it as a separately approved operational action.
- [FIX] Deleting “unreferenced” protected records by name is unsafe because multiple tables reference them through separate foreign keys -> Lock the targets, check every reference, delete only verified unreferenced rows, and prove zero dangling references.
VERDICT: NOT YET

### Visionary response (Fable)
- ACCEPTED: exact repository/run validation -> Rock 1 constrains the URL to `bryangerlach/rdgen/actions/runs/<numeric-id>`.
- ACCEPTED: telemetry freshness -> the leased worker refreshes a persisted source/timestamp/error snapshot before scheduling the next poll.
- ACCEPTED: shared caching -> Rock 1 defines a persisted run-ID cache with 90-second TTL and stale fallback.
- ACCEPTED: stale state -> UI must render GitHub status stale/unknown explicitly.
- ACCEPTED: percentage formula -> Rock 1 defines terminal-step aggregation, parallel/empty behavior, and fixtures.
- ACCEPTED: retry classification -> only a conservative recognized infrastructure-step allowlist can retry.
- ACCEPTED: incomplete/multiple failures -> no retry unless every failed job is completely classified safe.
- ACCEPTED: separate retry counter -> `workflow_retry_count`, reset only after successful artifact delivery.
- ACCEPTED: duplicate retry guard -> one guarded close/increment/outbox transaction plus concurrency proof.
- ACCEPTED: GitHub unavailable -> no automatic retry; telemetry becomes stale and RDGen polling continues.
- ACCEPTED: terminal reason -> stable mapped code and sanitized user-readable reason are persisted.
- ACCEPTED: stronger Rock 1 proof -> fixtures, migration/worker path, and API projection are required.
- ACCEPTED: server-side clone source -> Rock 2 adds an authorized non-secret source with server/preset data and asset copying.
- ACCEPTED: image fidelity -> cloning snapshots effective source assets; missing/expired assets are visible and need user replacement.
- ACCEPTED: clone authorization -> audience authorization applies and all clones are private.
- ACCEPTED: request server projection -> include and test `serverId`.
- ACCEPTED: remove all UUID rendering -> Rock 2 requires it and tests output.
- REJECTED: keep external-link warning -> the user explicitly requires no warning/marker. Existing ownership authorization stays enforced; choosing a named RDGen/GitHub destination in the dialog is the explicit consent.
- ACCEPTED: active refresh -> bounded React Query polling stops on terminal jobs.
- ACCEPTED: reduced motion -> use Motion preference support and test it.
- ACCEPTED: stronger Rock 2 proof -> detail/clone/dialog/poll/motion coverage is required.
- ACCEPTED: company field rules -> defaultDisplayName/defaultTechnicalName and fill-only-if-blank precedence are specified.
- ACCEPTED: latest artifact definition -> latest completed/partial job per profile/platform, all surviving files from that job.
- ACCEPTED: company authorization -> dedicated administrator-only projection and tests.
- ACCEPTED: complete company projection -> migration/schema/admin/options/mapping/form/clone coverage required.
- ACCEPTED: stronger Rock 3 proof -> history, selection, retention, authorization coverage required.
- ACCEPTED: checkbox scope -> central application checkbox styling; SweetAlert excluded because it has no application checkbox control.
- ACCEPTED: preset metadata proof -> rendered assertion added.
- ACCEPTED: cleanup evidence -> RF-PLAN records transaction counts and postcondition; it was a user-approved operational action.
- ACCEPTED: protected-record deletion safety -> transaction checks both referencing tables before deletion; plan records the evidence.

## Round 2
### Integrator findings (Codex, verbatim)
- [FIX] Rock 1’s proof command still omits the migration/resource-projection integration tests listed in its proof bullets -> Invoke those suites against a real migrated database.
- [FIX] GitHub’s jobs endpoint is paginated, so “all returned jobs are terminal” can incorrectly yield 100% or permit retry on incomplete data -> Paginate to exhaustion and persist a completeness marker before calculating progress or retry eligibility.
- [FIX] “Recognized infrastructure-step failure” still names broad categories and only constrains failed jobs, allowing a job with one safe and one unsafe failed step to retry -> Enumerate exact RDGen step identifiers and require every failed step to be recognized.
- [CLARIFY] The retry counter is called consecutive but resets only after artifact delivery, so an intervening terminal failure or manual retry can consume the previous sequence -> Define reset boundaries or rename it to a lifetime retry budget.
- [FIX] The clone source endpoint has no clone handle or atomic handoff in the normal create schema, so the submitted request cannot identify which server-side image snapshot to copy -> Add an actor-bound one-time clone token or make clone submission a server-side mutation.
- [FIX] Effective image snapshots can disappear between clone-source fetch and submission because retention has no lease -> Copy or lease the bytes atomically in a clone draft and define the missing/expired transition.
- [FIX] GitHub fetches have no explicit timeout while worker leases last two minutes, so a hung public API call can strand recovery -> Use a bounded abort timeout and classify timeout as stale telemetry.
- [CLARIFY] Optional company defaults may arrive as empty strings from the existing form, but the plan does not define normalization before `safeName` and technical-name validation -> Convert blank values to null consistently in schema and API handling.
- [CLARIFY] “Newest completed/partial job” has no defined completion timestamp or tie-break, so concurrent completions can make company history nondeterministic -> Order by a specified completion time with a stable job-ID tie-break.
- [FIX] Rock 2’s proof command runs only web tests and typecheck although its requirements include API clone authorization, image copying, and private visibility -> Explicitly run the API integration suite against migrated database state.
- [FIX] Rock 3’s proof command still does not invoke the web/history/download tests named in its proof bullets -> Run the administrator route, artifact-selection, authorization, and UI tests explicitly.
- [FIX] Rock 4’s proof command remains typecheck-only despite requiring rendered metadata and visual checkbox states -> Add an executable web/browser test command covering those states.
- [FIX] The repository has no existing browser runner or smoke script, so the new “browser smoke” proofs are not runnable as written -> Add the runner and script, or replace those claims with executable Vitest assertions.
- [FIX] Cleanup verification checks only job-resolved and attempt-remote references, missing server configuration, request configuration, attempt configuration, and artifact provenance references -> Check every foreign key into `protected_records` before deletion.
- [FIX] Deleting artifact rows does not remove their generated files, so the cleanup can leave orphaned binaries in protected storage -> Enumerate and remove or tombstone matching files and verify storage postconditions.
- [CLARIFY] The plan calls a prose count and postcondition “transaction evidence” without identifying an audit event, SQL artifact, timestamp, or operator record -> Attach verifiable evidence or document the cleanup in an external runbook.
VERDICT: NOT YET

### Visionary response (Fable)
- ACCEPTED: migration/projection proof -> Rock 1 now executes migrated-database API smoke coverage.
- ACCEPTED: pagination -> every jobs page is fetched before persistence, progress, or retry eligibility.
- ACCEPTED: exact failure allowlist -> only `Install vcpkg dependencies` is currently retryable; all other failures stop.
- ACCEPTED: consecutive reset boundaries -> success, manual retry, and other terminal failures reset the counter.
- ACCEPTED: clone token -> the one-time actor-bound token is consumed by normal request creation.
- ACCEPTED: atomic image snapshot -> clone-draft creation copies assets immediately; expiry/missing state is explicit.
- ACCEPTED: timeout -> GitHub calls abort at 10 seconds and record stale telemetry.
- ACCEPTED: blank company defaults -> normalize blank form values to null before schema/API persistence.
- ACCEPTED: latest-execution ordering -> terminal attempt `ended_at DESC`, then job ID.
- ACCEPTED: clone API proof -> Rock 2 explicitly runs migrated-database API coverage.
- ACCEPTED: company proof -> Rock 3 explicitly runs API and web coverage.
- ACCEPTED: rendered checkbox/preset proof -> Rock 4 uses executable Vitest assertions and final Fable browser verification.
- ACCEPTED: runner scope -> no new browser runner; Vitest is the permanent proof and Fable's existing browser device is final smoke only.
- ACCEPTED: complete protected-record audit -> production query covered all six foreign keys; FK enforcement and storage scan were verified.
- ACCEPTED: artifact storage -> the storage scan found no matching test artifact paths after the cascade.
- ACCEPTED: cleanup evidence -> `RF-PLAN.md` records exact IDs, transactional row counts, foreign-key audit, and zero-result checks; this user-authorized operation remains outside versioned product behavior.

## Round 3
### Integrator findings (Codex, verbatim)
- [DEFER] Rock 4 is cosmetic polish rather than operational transparency, safe recovery, reuse, or direct company actions -> Defer it until Rocks 1–3 are proven.
- [CLARIFY] RDGen status and GitHub conclusion can disagree, but the plan does not define which source controls delivery and retry eligibility -> Require RDGen failure before automatic retry and never discard a successfully delivered artifact.
- [FIX] The 90-second cache TTL limits freshness but does not limit persisted row growth -> Add pruning after terminal completion or a separate retention policy for action snapshots.
- [FIX] The allowlist still says each failed job has the exact vcpkg identifier without explicitly requiring every failed step to be that identifier -> Require every failed step to match the recognized identifier and reject mixed failures.
- [FIX] Clone drafts copy bytes into a 15-minute token but define no cleanup for abandoned drafts, failed submissions, or overridden image slots -> Sweep expired and unused draft assets transactionally.
- [FIX] Rock 2 and Rock 3 claim migrated-database API coverage but their commands still run the currently schema-only `test:requests` suite without migrations or `api:smoke-request` -> Add explicit migrated integration commands for clone, history, authorization, and downloads.
- [FIX] The cleanup storage scan for `*diag*teste*` cannot verify generated artifacts because storage keys use job IDs and random UUIDs rather than request names -> Capture the affected storage keys before deletion and verify those exact paths are gone.
VERDICT: NOT YET

### Visionary response (Fable)
- REJECTED: defer Rock 4 -> the user explicitly requested checkbox and preset fixes in this cycle; it is bounded and shares the web proof pass.
- ACCEPTED: status precedence -> RDGen success controls download; retry requires RDGen failure plus complete qualifying GitHub data.
- ACCEPTED: cache retention -> terminal snapshots are swept after 24 hours.
- ACCEPTED: mixed-failure protection -> every failed step must exactly equal `Install vcpkg dependencies`.
- ACCEPTED: clone-draft cleanup -> the sweep transaction deletes expired/consumed/failed/abandoned draft assets.
- ACCEPTED: explicit integration proof -> Rocks 1–3 now require migrated API smoke/integration coverage in addition to unit/web suites.
- ACCEPTED: storage evidence -> actual artifacts use random job keys, so the transaction count establishes no artifact provenance existed; the plan records that limitation and the zero matching storage scan.

## Round 4
### Integrator findings (Codex, verbatim)
- [FIX] The new proof depends on `pnpm test:api-integration`, but no root or workspace package defines that script -> Add the runnable script and runner to Rock 1 or replace it with an existing command.
- [CLARIFY] Terminal snapshot pruning is specified, but the plan does not state whether final request telemetry survives after the shared cache row is deleted -> Persist final normalized telemetry on the job/attempt and prune only cache data.
- [FIX] Cleanup evidence rules out generated files through provenance records, but provenance is nullable and request-image files use random paths outside artifact provenance -> Inventory `build_requests` image keys and all affected artifact storage keys before deletion, then verify those exact files are gone.
VERDICT: NOT YET

### Visionary response (Fable)
- ACCEPTED: integration runner -> Rock 1 creates the root `test:api-integration` runner, starts the local PostgreSQL/Redis stack, applies migrations, runs the cases, and tears the stack down.
- ACCEPTED: final telemetry retention -> normalized terminal telemetry persists on the job/attempt; only shared cache rows are pruned after 24 hours.
- ACCEPTED: storage verification -> post-deletion production inventory compared all live request-image, artifact, and branding keys against their storage directories; there are no unreferenced files.

## Round 5
### Integrator findings (Codex, verbatim)
- [FIX] The proof command runs `pnpm db:migrate` before `test:api-integration` boots PostgreSQL and Redis, so clean-environment verification can fail before the runner starts -> Let the runner own dependency startup and migrations, or start dependencies before `db:migrate`.
VERDICT: NOT YET

### Visionary disposition
- ACCEPTED (user-approved at the cap gate): standalone `pnpm db:migrate` removed from every proof command; the Rock 1 integration runner owns local dependency startup, migrations, test execution, and teardown.
- VERDICT: SAME PAGE by explicit user override at the five-round cap (2026-10-04); Rock 1 build authorized.

### Build handoff note (2026-10-04)
- Codex workspace hit its credit limit at Rock 1 launch (thread 01a1084f-93b6-7431-bf97-01e4bf509824, `turn.failed`). The user authorized the Visionary to implement Rock 1 directly during the ~4h outage; Codex resumes for later rocks and fix rounds. Deviation recorded per the Accountability Chart takeover rule.
