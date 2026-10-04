# RDGen improvements — October 2026

## Core focus
Make each build request operationally transparent and quick to reuse: show the real GitHub workflow state, recover safe infrastructure failures automatically, and make request/company actions direct.

## Constraints
- Preserve the existing TanStack Start/Nest/worker architecture and same-origin BFF.
- GitHub telemetry is fetched server-side only from a validated `https://github.com/bryangerlach/rdgen/actions/runs/<numeric-id>` URL emitted by RDGen. No browser token, scraping, or arbitrary URL fetches.
- The worker leases each job. A shared persisted action-snapshot cache keyed by validated run ID has a 90-second TTL and records source, observed time, normalized snapshot, completeness marker, and sanitized fetch error. Each refresh aborts after 10 seconds and paginates GitHub’s jobs endpoint to exhaustion. A GitHub 403/429/network/timeout leaves the latest snapshot marked stale and continues RDGen polling; it never triggers an automatic retry. Final normalized telemetry is persisted on the job/attempt before a worker sweep deletes terminal cache snapshots older than 24 hours.
- The worker calls the public GitHub Actions **jobs** API once per fresh snapshot. It calculates percentage as `floor(terminal steps / all named steps * 100)`, where terminal includes success/failure/skipped/cancelled/action-required. It caps active runs at 99%, uses 100% only when every fetched page is complete and every job is terminal, and reports unknown for empty/incomplete job payloads.
- RDGen’s terminal result controls delivery: successful RDGen status always downloads artifacts, and automatic retry requires **both** an RDGen terminal failure and complete GitHub job data. Treat that failure as safely retryable only when every failed GitHub step is exactly the current RDGen infrastructure-step identifier `Install vcpkg dependencies`; future identifiers require an explicit source-verified allowlist addition. Provider/input rejection, ambiguous starts, incomplete GitHub data, unavailable GitHub, mixed failures, and unclassified build/configuration failures are terminal without automatic retry.
- A dedicated `consecutive_workflow_infrastructure_failures` count advances transactionally while closing the active attempt. It queues replacement attempts only for failures one and two. The third persists a sanitized `workflow_retry_exhausted` reason and is visibly terminal. It resets after successful artifact delivery, a manual retry, or any non-infrastructure terminal failure.
- Passwords are never cloned or returned. Creating a clone draft atomically authorizes the source and copies its effective image bytes to a 15-minute actor-bound, one-time clone token. Submitting the normal request-create mutation consumes that token and creates a private request; the user may edit values and optionally enter new passwords before submission. Expired/missing image assets make the clone form show an actionable replacement requirement. The existing sweep removes expired, consumed, failed, and abandoned clone-draft assets transactionally.
- Selecting a company normalizes blank defaults to `null` and fills program/executable defaults only when their form fields are blank; user-entered values are never overwritten. Display name uses the existing safe display-name validation; executable name uses the existing technical-name validation.
- Keep the fixed platform order: Windows, Windows x86, Linux, Android, macOS.
- A company’s “latest execution” means the newest completed/partial job per profile × platform, ordered by its latest terminal attempt `ended_at` and then job ID. Expose every surviving artifact from that selected job, with its real filename.
- The Status RDGen destination dialog is the explicit user choice. Per the user requirement it has no external-link warning or yellow external marker; capability URLs remain authorization-gated by the existing owner/admin endpoint.
- Delete only the user-requested historical test/failed production requests, their cascading jobs/artifacts, and verified unreferenced protected records.

## Rock 1 — GitHub Action telemetry and safe workflow retry

**Scope**
- Restrict extraction of Actions URLs to RDGen’s exact repository/run route and numeric run ID.
- Add the provider’s normalized paginated GitHub Action/jobs response parser: run state, conclusion, active step, terminal-step percentage, completeness, exact infrastructure-step classification, bounded abort timeout, and terminal snapshot pruning.
- Add migration-backed action telemetry (`source`, observation time, stale/fetch-error state, completeness, status, conclusion, step, percentage) persisted to the job/attempt before shared snapshot pruning, plus dedicated consecutive workflow-infrastructure retry state and shared action snapshots.
- Persist action telemetry from the leased worker before each future RDGen poll. API request detail returns the safe telemetry only.
- In one guarded transaction, only after RDGen reports failure and complete GitHub data recognizes every failed step, close a retryable failed attempt, increment the dedicated counter, set a delayed retry and outbox record. On the third recognized infrastructure failure stop with a mapped reason. Successful delivery, manual retry, and other terminal causes reset the consecutive count.

**Done looks like**
- A running job exposes GitHub Action status, active step, estimated percentage, source and staleness when available.
- A `vcpkg`-style failed step creates up to two new RDGen attempts; a third is terminal with a user-readable reason.
- Unknown, incomplete, unavailable, input, and unclassified failures never auto-retry.

**Proof**
- Provider fixtures: URL validation, paginated complete/pending/parallel/empty/incomplete jobs, percentage aggregation, the exact recognized `Install vcpkg dependencies` failure, unrecognized failure, rate-limit fallback, and timeout fallback.
- Database-backed worker test: single guarded retry transaction under duplicate dispatch, reset boundaries, and three-failure exhaustion.
- Resource projection test returns safe telemetry and no capability URL, exercised after migrations against PostgreSQL.
- `pnpm test:rdgen-provider && pnpm test:worker && pnpm test:requests && pnpm test:web && pnpm typecheck && pnpm api:smoke-request`
- `pnpm test:api-integration` validates telemetry projection, clone authorization/private creation, company history selection, retention, and download authorization against the runner-provisioned migrated local PostgreSQL instance.
- Rock 1 adds the root `test:api-integration` script and runner; it boots the local PostgreSQL/Redis test stack, applies migrations, executes the API cases, and tears the stack down.

## Rock 2 — Request detail, status navigation, and cloning

**Scope**
- Rework the request detail into focused cards without any displayed UUID: concise request metadata, separate Full/QuickSupport sections, fixed ordered platform cards, state/progress/attempt/artifact zones, and execution loading animation that respects the browser reduced-motion preference.
- Use Rock 1 telemetry for explicit GitHub progress and render unknown/stale state honestly. React Query refreshes active request details on a bounded interval and stops on terminal jobs.
- Replace direct external buttons with one `Status RDGen` dialog offering `Abrir RDGen` and `Abrir GitHub Actions`; neither path shows an external-warning confirm nor a yellow marker.
- Add an authenticated clone-draft mutation that creates an actor-bound one-time token and atomically copies source effective-image assets. The normal create schema consumes the token while accepting editable non-secret source selections; source accessibility follows request audience authorization and every clone is private.

**Done looks like**
- Detail shows no UUID, no external warning/marker, stable OS ordering, split profile sections, and animated active work only when motion is allowed.
- The status dialog opens exactly the selected RDGen or GitHub Action URL.
- Cloning a request starts with equivalent non-secret configuration and images, blank passwords, editable values, and private visibility.

**Proof**
- API tests: clone authorization, private visibility, one-time/expired clone tokens, source projection omits passwords/capability URLs, effective-image copy and missing source asset handling, all against migrated database state.
- Web Vitest tests: no UUID, platform ordering, profile sections, status choice dialog, clone edits, live polling stop, reduced motion, and checkbox/preset rendering. Fable additionally performs the final browser smoke against the built app.
- `pnpm test:api-integration && pnpm test:web && pnpm --filter @rdgen/web typecheck`

## Rock 3 — Company defaults and request/artifact history

**Scope**
- Add optional `defaultDisplayName` and `defaultTechnicalName` columns/validation to companies and return them from both admin and request-options projections.
- Add an administrator-only `/admin/companies/:id` detail projection. It lists every company request and, for each profile/platform, selects the newest completed/partial job and returns all surviving artifact IDs/real filenames for that job.
- Add a company detail route linked from Companies. It renders request history and direct existing authorized artifact downloads.
- Keep public-download selection separate; company history/downloads are administrator-only.

**Done looks like**
- Company edit/create supports both defaults; selection in new/clone forms fills blank name fields while preserving user edits.
- An administrator can open a company, see its request history, and download every available artifact from the latest execution per profile/platform.

**Proof**
- Migration/schema/API tests cover blank-default normalization, options/admin projection, history ordering by terminal timestamp/job ID, artifact selection, retention, download authorization, and non-admin denial.
- `pnpm test:api-integration && pnpm test:web && pnpm --filter @rdgen/web typecheck`

## Rock 4 — Form and preset polish

**Scope**
- Centralize styled native checkbox behavior for forms and dialogs, including checked, unchecked, focus, disabled, and form-stack layout cases. SweetAlert is not reimplemented; only application checkbox controls are in scope.
- Change preset metadata from `Tipo do preset · versão · modo de aprovação` to `Versão · Direção de conexão`.

**Done looks like**
- Application dialog/form checkboxes visually match the design across all states.
- Preset rows show version and connection direction.

**Proof**
- Web Vitest assertions cover preset metadata and checkbox rendered checked/unchecked/focus/disabled attributes/classes; Fable verifies visual states in the built browser surface.
- `pnpm test:web && pnpm --filter @rdgen/web typecheck`

## Completed production data cleanup
- Removed `Diag Teste` (`994575ed-eb6f-4251-8252-42884a112532`, indeterminate) and `Diag Fix Teste` (`a06cd457-ffa0-4aa5-83a2-426707e57c18`, failed).
- Transaction evidence: two requests and their cascading records deleted; three protected records deleted only after checks that no `rustdesk_servers.configuration_protected_id`, `build_requests.resolved_configuration_protected_id`, `build_jobs.resolved_configuration_protected_id`, `build_attempts.remote_metadata_protected_id`, `build_attempts.resolved_configuration_protected_id`, or `artifacts.provenance_protected_id` reference remained. PostgreSQL foreign keys enforced the same condition; the three deleted records corresponded to two job configurations plus one remote metadata record, so no artifact provenance/file existed for either failed request. Postcondition query returned zero target requests and the production storage scan returned no matching `*diag*teste*` file.
- Post-deletion storage inventory compared every live `build_requests` image key, `artifacts.storage_key`, and branding storage key with files under `storage/request-images`, `storage/generated/artifacts`, and `storage/brandings`; it found no unreferenced files.
