# AGENTS.md

Context for any human or AI agent working on this repository. Read this before touching code.

## What this is

RDGen Automator is a multi-user web panel that automates building custom RustDesk clients through [RDGen](https://github.com/bryangerlach/rdgen). An operator picks a RustDesk server configuration, a preset (behavior/permissions), an optional branding (company identity + images), a permanent password policy, profiles, platforms, and a RustDesk version. The system expands that into a durable job matrix (one job per profile × platform), drives RDGen through its web flow, downloads and validates the resulting artifacts, and keeps them available for authorized users with a retention policy.

It exists because RDGen's own web UI is a manual, one-off form with no history, no multi-client reuse, and no artifact lifecycle. This project adds persistence, authorization, retry/reconciliation, and a real admin surface on top of it.

## Monorepo layout

```
apps/api      NestJS. Auth, admin CRUD, build requests, authorization, downloads.
apps/worker   BullMQ. Drives the RDGen lifecycle: submit, poll, download, validate, retain.
apps/web      TanStack Start (React 19). Operator UI, same-origin BFF proxy to the API.
packages/domain  Shared, framework-free: Zod schemas, encryption, lifecycle state machine,
                 artifact handling, environment loading, the static RDGen releases list.
```

Package manager: pnpm workspaces (`pnpm-workspace.yaml`), Node 22, Corepack. There is no shared `tsconfig` compiler project reference graph beyond `tsconfig.base.json`; each app has its own `tsconfig.json`.

## Data model (PostgreSQL, see `apps/api/src/database/migrations/*.sql`)

- `users` / `sessions` — cookie-based sessions, argon2 password hashing, login rate limiting.
- `rustdesk_servers` — a named RustDesk deployment's connection parameters (host, port, public key, API server, link/download URLs), encrypted at rest. **Not treated as secret in the UI**: these values are embedded in every RustDesk client built from them, so admins see and edit them in plain form. Encryption at rest is defense-in-depth for the database, not an attempt to hide them from authorized admins.
- `presets` — behavior/permissions only (direction, approval mode, 12 boolean permissions). No branding, no identity.
- `brandings` — company identity, separate from presets: display name, Android application id, theme/themeScope, and three optional image slots (icon, logo, privacy-screen image), streamed from protected storage.
- `build_requests` — one request per operator action: visibility (private/published), client display name, chosen server, chosen branding (optional), platforms, a single RustDesk version, optional permanent password with optional per-profile override (`profilePasswords.{full,qs}`), optional per-slot image overrides.
- `jobs` — one row per (profile × platform) expansion of a request. State machine: `rascunho → enfileirado → iniciando → aguardando_rdgen → baixando → validando → concluído`, with `início_indeterminado` as a dead-letter state when the RDGen response is lost after submission (no auto-resubmit — a human reconciles or accepts the risk of a duplicate external build).
- `artifacts` — delivered files, immutable provenance record, retention metadata.
- `outbox` — transactional outbox for events the worker consumes.

Migrations are plain numbered SQL files, applied forward-only by `apps/api/src/database/migrate.ts` (`pnpm db:migrate`). There is no down-migration tooling; fixing a bad migration means writing a new forward migration.

## Key flows

**Request → jobs.** `apps/api/src/requests/requests.service.ts` validates the input against `packages/domain/src/configuration.ts` schemas, resolves the chosen branding/preset/server, and expands `platforms × profiles` into job rows. `composeResolvedJobConfiguration` in that file merges preset + branding + request overrides into the exact payload RDGen expects — branding is optional, so this function must tolerate `branding === undefined` (a real bug: an earlier version used a non-null assertion here and crashed on unbranded requests; there is a regression test for it now).

**Worker lifecycle.** `apps/worker/src/lifecycle.ts` and `packages/domain/src/rdgen-provider.ts` drive RDGen's own web flow (submit the Django-style form, poll for completion, download the artifact) via BullMQ jobs with retry/backoff. `packages/domain/src/releases.ts` is a **static** hardcoded list of RDGen versions (nightly, 1.4.0–1.4.9) matching RDGen's own form choices — there is no live scraping of RDGen's release list; the "Atualizar versões" button in the UI is an intentional stub.

**Artifacts.** `packages/domain/src/artifacts.ts` + `apps/worker/src/artifact-delivery.ts` validate downloaded files (including PNG validation in `png.ts` for branding images), store them under `APP_STORAGE_PATH`, and `apps/worker/src/retention.ts` expires them on schedule.

**Auth.** Cookie sessions (`apps/api/src/auth/session.service.ts`), argon2 hashing, CSRF token issued alongside the session. The frontend never does client-side persona switching — authorization is fully server-backed.

## Frontend architecture (`apps/web`)

TanStack Start (file-based routes in `src/routes/`), React 19, Tailwind v4, Radix primitives, Framer Motion (`motion` package), React Hook Form + Zod, React Query for all server state.

- `src/routes/api/backend/$.ts` + `src/lib/proxy.ts`: a same-origin BFF proxy. The browser never talks to the API's own origin/port directly; every `/api/backend/*` request is forwarded server-side with cookies, CSRF header, and `Idempotency-Key` preserved, redirects not followed, and `Cache-Control: private, no-store` on the response. This is what lets the API stay on a loopback-only port in production.
- `src/lib/api.ts`: thin fetch wrappers per resource.
- `src/lib/api-provider.tsx`: shape converters between the UI's domain types and the API's wire schemas (`uiServer`/`realServer`, `uiConfig`/`realPreset`, `uiBranding`/`realBranding`, `optionPreset`/`optionBranding`). Portuguese UI enum values (e.g. approval mode, direction) are translated here — never let Portuguese strings leak into the API layer or vice versa.
- `src/lib/types.ts`: shared UI types plus the `permissionLabel`/`statusLabel`/`platformLabel` presentation maps. If you add a permission or a job status, add its label here or it will render as a raw English/snake_case key.
- `vite.config.ts` composes the official plugins directly (`@tanstack/react-start/plugin/vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `vite-tsconfig-paths`, `nitro/vite`, `@tanstack/devtools-vite`) — there is no wrapper package. Nitro preset is `node-server`; production runs as `node .output/server/index.mjs`, not an edge/worker runtime.

Frontend conventions carried over from the project that originated this UI:
- Keep screens wired through `src/lib/api-provider.tsx`; never add in-memory/mock fixtures back in.
- Keep each shareable content screen as its own TanStack route (preserves navigation and page-specific metadata).

## Configuration & security model

- `packages/domain/src/environment.ts` is the single source of truth for env vars: `DATABASE_URL`, `REDIS_URL`, `APP_STORAGE_PATH`, `APP_ENCRYPTION_KEY` (canonical base64, exactly 32 bytes), `APP_ENCRYPTION_KEY_ID`, `API_PORT`, `WEB_PORT`, `WORKER_PORT`, `APP_BIND_HOST` (default `127.0.0.1` — services bind to loopback by default; only the web app should be reverse-proxied out), `API_BASE_URL`.
- `pnpm env:generate` creates a throwaway dev `.env`. **Never run it against production** — losing `APP_ENCRYPTION_KEY` makes every encrypted row (server configs, passwords) permanently unreadable.
- A production build request sends the permanent password, the RustDesk server's key material, and branding assets to RDGen over the network. This is inherent to how RDGen works, not a bug; the UI surfaces an explicit warning before submission.
- Encryption is for the database at rest, not for hiding RustDesk connection details from admins — see the `rustdesk_servers` note above.

## Conventions

- **Clean cutover.** No shims, no dual code paths, no deprecated-but-kept code. When something is replaced, the old version is deleted in the same change, including its tests, docs, and callers.
- **Real proof, not pasted output.** Changes are verified by actually running migrations, the built server, and the test suite — not by trusting a description of what should happen.
- **No speculative abstraction.** Solve the asked problem; don't generalize beyond it.
- Edits go through the repository's structured tools where available; no ad hoc `sed`/`python` one-off rewrites of source files.

## Local development

```bash
cp .env.example .env
pnpm env:generate
docker compose up -d postgres redis
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

## Tests

Each suite is independently runnable; there is no single `pnpm test` that runs everything:

```bash
pnpm typecheck            # every workspace, tsc --noEmit
pnpm test:encryption
pnpm test:authorization
pnpm test:sessions
pnpm test:requests
pnpm test:presets
pnpm test:worker
pnpm test:rdgen-provider
pnpm test:state-machine
pnpm test:artifacts
pnpm test:web             # vitest, apps/web only
pnpm dev:smoke            # end-to-end smoke against a running local stack
pnpm test:retention        # scripts/retention-smoke.ts
```

## Deployment

Two supported paths, both documented in `README.md`: PM2 on a host with externally managed PostgreSQL/Redis (`ecosystem.config.cjs`), or a full Docker Compose stack (`compose.production.yaml`, multi-stage `Dockerfile` with `api`/`worker`/`web` targets). In both, only the web process should be reverse-proxied publicly; API and worker stay on loopback/internal network. Run `pnpm db:migrate` before restarting services after a pull — migrations are not applied automatically on boot.

## License

AGPLv3 (see `LICENSE`). Network use (e.g. operating this as a hosted service for others) triggers the source-availability obligation — see the license text, section 13.
