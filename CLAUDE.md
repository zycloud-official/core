# core

**core** is the central backend for the entire zycloud PaaS stack — the auth authority, data layer, and deployment orchestrator that separate frontends and integrations build on. Its first and current capability is Netlify-style GitHub deploys, but the codebase is deliberately structured so that identity, deployment, and source-provider concerns stay decoupled as the platform grows (see [Architecture Vision](#architecture-vision)).

Today that means: members connect their GitHub repos, and every push to the default branch automatically builds and deploys their app via a GitHub App + CapRover — no CLI, no credentials to manage.

Deployed at `core.zycloud.space` on the **zycloud** CapRover instance. The separate frontend SPA (`app/`, its own git repo in this monorepo) is deployed at `app.zycloud.space` and consumes this API over a cookie session — see the root `../CLAUDE.md` for the cross-project contract. Member apps are served at `https://{owner}-{repo}.zycloud.space`.

**Package manager: yarn** — use `yarn` for all installs and script runs. Do not use `npm` or `npx`; use `yarn` equivalents instead.

---

## File map

| File                                 | Purpose                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.js`                       | Server entry — boots `app.js` and listens                                                                                                       |
| `src/app.js`                         | Express app — middleware and route registration                                                                                                 |
| `src/db.js`                          | Prisma client singleton                                                                                                                         |
| `src/middleware/session.js`          | Account sessions — `createSession`/`clearSession`/`loadSession`/`requireSession` (opaque-token cookie)                                          |
| `src/caprover.js`                    | CapRover API client (login, create app, upload, SSL)                                                                                            |
| `src/detect.js`                      | Framework detection → generates `captain-definition` (see [Framework templates](#framework-templates))                                          |
| `src/deploy.js`                      | Deploy pipeline: download → extract → inject → repack → upload                                                                                  |
| `src/integrations/github/client.js`  | GitHub App instance + `downloadTarball`                                                                                                         |
| `src/integrations/github/oauth.js`   | GitHub login: `GET /auth/github`, `/callback/github`, `POST /auth/logout` — resolves the account behind a GITHUB identity (`githubOAuthRoutes`) |
| `src/integrations/github/webhook.js` | `POST /webhook/github` — HMAC verify + event handlers; installs become GitHub `SourceConnection`s (`githubWebhookRoutes`)                       |
| `src/routes/dashboard.js`            | `GET /dashboard` — the account + its apps and deploy status                                                                                     |
| `prisma/schema.prisma`               | Dev + production schema (PostgreSQL) — the default `@prisma/client`                                                                             |
| `prisma/schema.test.prisma`          | Test-only schema (SQLite); generates a separate client to `prisma/generated/test-client` so `yarn test` never clobbers the PostgreSQL client   |
| `tests/fixtures/`                    | Per-framework sample apps for detection + build tests                                                                                           |
| `scripts/start.sh`                   | Container entrypoint — runs `prisma db push` then starts server                                                                                 |

> GitHub-specific code (App client, OAuth, webhook) lives under
> `src/integrations/github/` per the [module boundaries](#module-boundaries) —
> it must not contain deploy logic. `src/deploy.js` and `src/caprover.js` stay
> provider-agnostic.

---

## Local dev

Dev runs on PostgreSQL (same engine as prod). Create a local database (e.g.
`createdb zycloud_dev`) and point `DATABASE_URL` at it, then:

```bash
cp .env.example .env    # set DATABASE_URL to your local Postgres
yarn install
yarn db:generate        # generate the Prisma client (PostgreSQL)
yarn db:push            # create/sync local DB
yarn dev
```

Use `yarn db:studio` to browse the DB. Use smee.io or ngrok to receive webhooks locally.

> **There is only one Webhook URL per GitHub App.** The `zycloud-app` GitHub App (prod) has its
> Webhook URL (and Authorization callback URL) pointed at `core.zycloud.space`. Repointing it at a
> local ngrok/smee tunnel to receive webhooks locally means **prod stops receiving `installation`/
> `push` webhooks** for as long as it's repointed — there's no way to have both without one of:
> 1. **Temporarily repoint the prod App's Webhook URL** to your tunnel, test, then switch it back.
> 2. **Register a separate dev-only GitHub App** (its own `GITHUB_APP_ID` / private key / webhook
>    secret / client id+secret), with its Webhook URL pointed at your local tunnel from the start.
>    Put its credentials in your local `.env` instead of the prod ones. Install it on a scratch repo
>    you don't mind granting a throwaway App access to. This is the safer default — it never touches
>    prod config, so use it unless you have a specific reason to test against the real App.

> **Tests use SQLite, not your dev DB.** `vitest.config.js` sets
> `DATABASE_PROVIDER=sqlite` + a `file:` URL, and `tests/global-setup.js` pushes
> `schema.test.prisma`, whose client is generated to a separate path. So
> `yarn test` is self-contained and never touches your Postgres dev DB or its
> client — no need to run any `db:*` script before testing.

If also running the `app/` SPA locally (`yarn dev`, vite default port), set `APP_URL=http://localhost:5173`
in `core`'s `.env` — CORS only allows the exact origin in `APP_URL`, so it must match the SPA's real
local origin, not the production value from `.env.example`.

### Schema changes — no migration files (yet)

There's no `prisma/migrations/` directory and no `prisma migrate` workflow — `db:push` (`yarn
db:push` locally, `scripts/start.sh` on every container boot in prod) is the only mechanism, in both
dev and prod. **The system isn't carrying real production data yet**, so prefer editing
`schema.prisma`/`schema.test.prisma` directly (add/rename/remove fields and models freely) over
preserving migration history — no need for `prisma migrate dev` or hand-written SQL at this phase.

**Exception:** flag it explicitly (don't just push silently) whenever a schema change could be
destructive against the *already-deployed* prod DB on the next `db push` — e.g. a required column
with no default added to a table that already has rows, a dropped/renamed column, or a narrowed
type. Those may need a manual fix (backfill, temporary default, one-off SQL) timed around that
deploy, so call them out before merging rather than after something breaks.

---

## Testing

`yarn test` runs Vitest. Tests are split into two tiers:

1. **Fast tier** (always runs) — unit + route tests, plus framework **detection**
   tests that snapshot the generated `captain-definition` (`tests/detect*.test.js`).
   No Docker, no network.
2. **Build tier** (`tests/build.test.js`, opt-in via `RUN_DOCKER_BUILDS=1`) — for
   each fixture, generates the captain-definition exactly as CapRover would
   (`dockerfileLines` → `Dockerfile`), runs `docker build`, starts the container,
   and HTTP-probes the exposed port. This is the real "does this template actually
   build and serve" check — CapRover just runs `docker build` on the
   captain-definition, so it faithfully reproduces production without a CapRover
   instance.

```bash
yarn test                      # fast tier only (default)
RUN_DOCKER_BUILDS=1 yarn test  # + Docker build tier (requires Docker)
```

Fixtures live in `tests/fixtures/<framework>/`. Update detection snapshots with
`yarn vitest run -u` when a generated Dockerfile legitimately changes.

### CI

`.github/workflows/nightly-builds.yml` runs the full suite with the Docker build
tier nightly (03:00 UTC) and on manual dispatch — keeping local `yarn test` fast
while the slow build tier still guards against template regressions and
base-image drift (`node:lts-slim`, `nginx:alpine`, `python:3.12-slim`).
_(Planned: a per-push workflow running the fast tier.)_

---

## Framework templates

`src/detect.js` exports a `buildPacks` registry — one entry per preset, each
holding a `captainDef(dir)` builder and a `containerHttpPort`. This is the
**authoritative** source `deploy.js` looks up by the member's explicit
`AppConfig.buildPack` choice (see [App Configuration](#app-configuration) below).
`detectFramework(dir)` still exists as a guess over the same registry (file
sniffing → registry key), but it's advisory only — not wired into the connect
flow (no auto-suggestion in v1; the connect form just lists all 8 presets).
Guessing still runs **top-down, first match wins** — any `package.json` falls
through to the generic `node` preset, so new JS-framework presets must be
inserted _above_ it.

| Preset           | Guess trigger                       | Build target                         | Port |
| ---------------- | ------------------------------------ | ------------------------------------ | ---- |
| `dockerfile`      | `Dockerfile` present                 | repo's own Dockerfile, used as-is    | 80\* |
| `vite`            | `vite` / `@vitejs/plugin-*` in deps  | multi-stage build → nginx            | 80   |
| `nextjs`          | `next` in deps                       | build + start                        | 3000 |
| `node`            | any other `package.json`             | install prod deps → `node index.js`  | 3000 |
| `python-django`   | `django` in reqs or `manage.py`      | `gunicorn <pkg>.wsgi`                | 8000 |
| `python-fastapi`  | `fastapi` in reqs                    | `uvicorn main:app` (else `app:app`)  | 8000 |
| `python-flask`    | `requirements.txt` only              | `python app.py`                      | 5000 |
| `static`          | `index.html` present                 | nginx serves files                   | 80   |
| `unknown`         | none of the above (guess path only)  | `null` — deploy proceeds without one | —    |

\* `dockerfile`'s port is a documented default, not a detection — CapRover has
no way to introspect an arbitrary Dockerfile's `EXPOSE`.

Node templates are **package-manager-aware**: the generated Dockerfile uses
npm / yarn / pnpm based on the committed lockfile, and falls back to
`npm install` when none is present (`npm ci` aborts without a lockfile).

**Adding a template:** add a `<fw>Def(dir)` builder + a `buildPacks` entry (plus
a detection branch if it should also be guessable) in `detect.js`, then add a
fixture under `tests/fixtures/<fw>/` — a minimal but _real_ app whose `/`
responds `hello from <fw>`. Wire it into both test tiers, then run the build
tier: if the image builds and serves, the template is proven.

### Known gaps

- **Python entrypoint/port are conventions, not detected** — Flask is assumed to
  be `app.py` on `:5000`; a non-conventional layout still slips through.
- **No `pyproject.toml` / poetry / uv detection** — Python projects without a
  `requirements.txt` are currently classified `unknown`.
- **Long tail of JS frameworks** (SvelteKit, Astro, Nuxt, Remix, CRA, Angular)
  falls through to the generic `node` template and will mostly fail to build.
- **Buildpack auto-suggestion isn't wired up** — the connect form lists all 8
  presets and the member picks one; `detectFramework`'s guess isn't surfaced as
  a pre-filled suggestion yet. Would need a new endpoint to fetch repo contents
  before the form opens (today's `GET /github/repos` only returns GitHub
  metadata) — deferred.

---

## App Configuration

**Status: backend done (2026-07-16).** Every connected app used to deploy on a
guess — `detect.js` picked a framework template, env vars were never sent to
CapRover, and the webhook only ever deployed pushes to the repo's default
branch. `AppConfig` now carries real, member-chosen deploy config:

- **`buildPack`** (String, required, no default) — explicit member choice from a
  fixed preset list (`dockerfile`, `vite`, `nextjs`, `node`, `python-django`,
  `python-fastapi`, `python-flask`, `static`; see [Framework templates](#framework-templates)
  above). **v1 has no auto-suggestion** — the connect form lists all presets and
  the member picks one; `detectFramework`'s guess isn't wired into the picker
  (deferred — see Known gaps above). `deploy.js` looks up the chosen buildpack's
  `captainDef(dir)` builder from the `buildPacks` registry directly instead of
  calling `detectFramework`. A repo's own `captain-definition`, if present, still
  wins over any buildpack (unchanged from before).
- **`targetBranch`** (String, required — pre-filled with the repo's
  `default_branch` at connect time, but overridable). `webhook.js`'s `handlePush`
  looks up `app` + `config` **before** the branch check now (previously the
  reverse) and compares `ref` against `app.config.targetBranch` instead of
  hardcoding GitHub's `default_branch`.
- **App naming — randomly generated, not member-chosen (yet).** The original plan
  for this feature added a member-chosen, globally-unique `codename` field with a
  live availability check. That was redirected: naming isn't "member picks a
  subdomain" — free-tier accounts get a **randomly generated** app name
  (`src/appName.js`'s `generateAppName()`, e.g. `brave-otter-4821`); a future paid
  tier may let members choose their own (not built). No new field was added — the
  **existing** `App.caproverAppName` column is reused, now marked `@unique` (it
  wasn't before; the old `{owner}-{repo}` derivation was implicitly collision-free,
  random generation needs the DB to actually enforce it). `POST /apps` retries on
  the rare `caprover_app_name` collision (up to 5 attempts, checked specifically
  via the Prisma error's `meta.target`, not a blind retry on any unique-constraint
  hit). No slug validation, reserved-word list, or availability endpoint exists —
  nothing about the name is user-supplied.
  **Renaming (deferred, relevant to a future paid-tier "pick your own name"
  feature):** CapRover supports it via `POST /api/v2/user/apps/appDefinitions/rename`
  (`{oldAppName, newAppName}`), traced through CapRover's current source
  (`ServiceManager.renameApp` / `AppsDataStore.renameApp` — not in CapRover's
  public API docs at all). It: requires the old app's Docker service to
  currently be running (throws otherwise) → removes that service → renames the
  stored app definition → recreates the service under the new name → re-enables
  SSL if it was on. Concretely: **brief downtime is guaranteed** (steps are
  sequential, not atomic) and **there's no rollback** if a later step fails after
  the old service has already been removed. Whoever builds this must: only allow
  renaming while the app's service is actually running, and only update our own
  `caproverAppName` column *after* CapRover's rename call succeeds — never assume
  success. (Two old CapRover GitHub issues, #490/#701, reported renames deleting
  apps outright; both are 2019–2021, closed as stale/unreproducible, and current
  source looks materially more careful — but there's no changelog confirming a
  fix, so treat this as a real, if unlikely, failure mode.)
- **Env vars** (optional — zero is valid) — a separate `EnvVar` model (`key`,
  `value`, `secret: Boolean`, `keyVersion: Int @default(1)`, `appConfigId`) rather
  than a JSON blob on `AppConfig`. `value` is **encrypted at rest** — see
  [Env var secret encryption](#env-var-secret-encryption) below. `caprover.js`'s
  `updateAppDefinition(appName, {containerHttpPort, envVars})` sends
  `envVars: [{key, value}]` (decrypted just-in-time in `deploy.js`) on every
  deploy, not just the first — an empty array just means no env vars are set.

### Pipeline changes made

- `github.js`'s `POST /apps` stayed a **single endpoint**; its request body grew
  to `{githubRepo, installationId, buildPack, targetBranch, envVars?}` (no name
  field), and it creates `App` + a fully-populated `AppConfig` (+ `EnvVar` rows)
  together in one request. `AppConfig` is only ever created with `buildPack`/
  `targetBranch` present (never empty), which makes the webhook's `!app.config`
  gate meaningful instead of a no-op.
- `deploy.js`: dropped the `detectFramework` call in favor of
  `buildPacks[buildPack]`; uses the stored `app.caproverAppName` (passed in by the
  caller) instead of an owner/repo-derived name for CapRover create/upload/SSL
  calls; derives `containerHttpPort` from the buildpack instead of a hardcoded
  `80`; pushes decrypted env vars via `updateAppDefinition` on every deploy.
- `webhook.js`: reordering the app+config lookup ahead of the branch check
  surfaced a latent bug — `handlePush` used to **re-derive** `appName` from
  `owner/repo` independently of what was stored in `App.caproverAppName` at
  connect time. Harmless before only because the derivation was deterministic;
  now that names are random, it reads `app.caproverAppName` from the DB instead.
- `detect.js`: reshaped from "guess and return a template" into the keyed
  `buildPacks` registry described in [Framework templates](#framework-templates).
  `deploy.js` consumes it via explicit lookup; `detectFramework` still exists as
  an unwired guess path.
- `ConnectRepoModal.tsx` / dashboard (`app/`) — **not done yet.** The UI still
  fires `connectRepo` immediately with just `{githubRepo, installationId}`; it
  needs updating to collect `buildPack`/`targetBranch`/`envVars` in a form before
  submitting (still one `POST /apps` call) and will start getting 400s from the
  new required fields until it's updated. Deliberate follow-up, not scoped here.

### Env var secret encryption

`EnvVar.value` must not be plaintext in Postgres — it will hold DB URLs and API
keys. Plan, designed so a future key rotation is a data migration rather than a
schema/API redesign:

1. **Key**: one 32-byte symmetric key (`openssl rand -base64 32`), stored as a new
   env var (`ENV_VAR_ENCRYPTION_KEY`) — provisioned the same way
   `GITHUB_APP_PRIVATE_KEY`/`CAPROVER_PASSWORD` already are (CapRover App Config in
   prod, `.env` locally). Never committed.
2. **Algorithm**: AES-256-GCM via Node's built-in `crypto` — no new dependency,
   and it's authenticated (detects tampering, not just confidentiality). Each value
   gets its own random IV.
3. **Schema**: `EnvVar.value` stores an opaque blob (`iv:authTag:ciphertext`, all
   base64) instead of plaintext, plus `keyVersion Int @default(1)` *from day one*
   — that's what makes rotation later additive instead of a schema change under
   pressure.
4. **One choke point**: a single `src/crypto/secrets.js` exporting
   `encryptSecret`/`decryptSecret`. Nothing else touches `crypto` directly.
5. **Where it happens**: encrypt right before the Prisma write in `POST /apps`
   (plaintext never touches the DB); decrypt only inside `deploy.js`, right before
   building CapRover's `envVars` payload — decrypted values never leave that
   request.
6. **API rule**: any `GET` of `AppConfig`/`EnvVar` redacts `secret: true` rows
   (`value: null`) — write-only, same UX as GitHub Actions secrets. Non-secret rows
   (e.g. `NODE_ENV=production`) return normally.
7. **Threat model, stated explicitly**: defends against DB dumps/backups or a
   SQL-injection-style read landing on plaintext credentials. Does **not** defend
   against the `core` process itself being compromised (whoever can read
   `process.env.ENV_VAR_ENCRYPTION_KEY` can decrypt everything) — that's the
   standard ceiling for app-level envelope encryption without a separate KMS/HSM,
   and it's proportionate at this project's scale.
8. **Rotation** (documented now, not built for v1): add
   `ENV_VAR_ENCRYPTION_KEY_V2` alongside the old key; write path always encrypts
   with the latest version; a one-off script decrypts `keyVersion: 1` rows and
   re-encrypts them as `v2`; retire the v1 key once migrated. No schema migration
   needed at rotation time — that's the point of `keyVersion` existing from day one.

### Known issues / open risks

- **This only covers creation, not editing.** Env vars especially will need
  rotation/updates later, but `buildPack`/`targetBranch`/env vars have no `PATCH`
  endpoint or edit UI yet — connect-time only.
- **Frontend not updated yet** — `ConnectRepoModal.tsx` still sends the old
  two-field request; it needs the new form (buildpack picker, branch field, env
  var editor) before members can actually use any of this. See "Pipeline changes
  made" above.
- **Buildpack auto-suggestion needs plumbing that doesn't exist** — deferred for
  v1 (see [Framework templates](#framework-templates) above): today's `GET
  /github/repos` only returns GitHub metadata, never repo contents.
- **No member-chosen app name yet** — a future paid tier may want this (see the
  CapRover rename research above), but v1 is random-generation only; the
  `App.caproverAppName` column has no slug/reserved-word validation because
  nothing writes to it except the generator.

---

## Environment variables

| Var                      | Description                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `PORT`                   | Server port (default `3000`)                                                                       |
| `BASE_URL`               | `https://core.zycloud.space` — this API's own origin                                               |
| `APP_URL`                | `https://app.zycloud.space` — the frontend SPA's origin; used for the post-login redirect and CORS |
| `DATABASE_PROVIDER`      | `postgresql` for dev + prod. (Tests set `sqlite` themselves via vitest.config.js.)                 |
| `DATABASE_URL`           | PostgreSQL connection string (dev: local Postgres; prod: managed Postgres)                         |
| `GITHUB_APP_ID`          | Numeric GitHub App ID                                                                              |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key with literal `\n` for newlines                                                     |
| `GITHUB_WEBHOOK_SECRET`  | Webhook secret from GitHub App settings                                                            |
| `GITHUB_CLIENT_ID`       | OAuth client ID                                                                                    |
| `GITHUB_CLIENT_SECRET`   | OAuth client secret                                                                                |
| `GITHUB_APP_SLUG`        | App URL slug (e.g. `github-integration`)                                                           |
| `CAPROVER_URL`           | `https://captain.zycloud.space`                                                                    |
| `CAPROVER_PASSWORD`      | CapRover admin password                                                                            |
| `ENV_VAR_ENCRYPTION_KEY` | Base64-encoded 32-byte AES-256-GCM key for `EnvVar.value` (see [Env var secret encryption](#env-var-secret-encryption)). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. |

---

## Deploy to zycloud

**One-time CapRover setup:**

1. Create app named `github-integration`
2. Set all env vars above
3. Add persistent volume at `/app/data` (Postgres: skip this)
4. Enable HTTPS

Subsequent deploys: `caprover deploy` CLI, or wire this repo through its own webhook to self-deploy.

> **Note:** `yarn.lock` must be committed before deploying — the Dockerfile uses `--frozen-lockfile`. Run `yarn install` locally to generate it.

---

## Architecture Vision

This project will evolve into **core** — the central backend for the entire zycloud PaaS stack.

### Responsibilities of core

- **Shared auth** — single account system for all zycloud services (dashboard, monitors, integrations). Users authenticate once; third-party connections (GitHub, GitLab, etc.) are linked to their zycloud account.
- **Deployment orchestration** — deployment runners, CapRover API calls, build logs, status tracking.
- **Data layer** — all PaaS-related data: accounts, connected integrations, apps, deploy history.
- **REST API** — exposes endpoints consumed by separate frontend apps (dashboard, monitors) and other integrations.

### Auth design

- Core is the auth authority for the zycloud stack — issues and validates sessions/tokens.
- Third-party OAuth flows (GitHub, GitLab) use a `state` parameter tied to the authenticated zycloud session to prevent CSRF account-linking attacks.
- GitHub/GitLab OAuth tokens stored in core, scoped to the owning account.

### Module boundaries

| Module                     | Owns                                                  |
| -------------------------- | ----------------------------------------------------- |
| `src/routes/auth.js`       | Zycloud account login/logout/session                  |
| `src/integrations/github/` | GitHub App, OAuth, webhook handling — no deploy logic |
| `src/deploy.js`            | Provider-agnostic deploy pipeline                     |
| `src/caprover.js`          | CapRover API — no integration-specific concepts       |
| `src/routes/api/`          | REST endpoints for dashboard and other frontend apps  |

---

## Roadmap

**Recently done**

- [x] Isolated GitHub code into `src/integrations/github/` (module boundaries)
- [x] Package-manager-aware Node builds (npm / yarn / pnpm, lockfile-driven)
- [x] Python framework detection — Django & FastAPI, not just Flask
- [x] Two-tier test setup: detection snapshots + opt-in Docker build tier
- [x] Nightly CI running the Docker build tier
- [x] **App Configuration backend** (see [App Configuration](#app-configuration) above) — `AppConfig.buildPack`/`targetBranch`, `EnvVar` model encrypted at rest, random app-name generation (`App.caproverAppName` reused, now unique), `webhook.js` reordered to use `app.config.targetBranch` + the stored app name, `containerHttpPort` derived per buildpack, bare-Dockerfile gap fixed

**Next up — App Configuration frontend**

- [ ] `ConnectRepoModal.tsx` (`app/`): form for buildpack picker / branch field / env var editor before submitting `POST /apps` — backend contract is ready and waiting
- [ ] `libs/api.ts` (`app/`): update `connectRepo`'s request shape to match

**Near-term (templates & quality)**

- [ ] Per-push CI workflow running the fast test tier
- [ ] Detect `pyproject.toml` / poetry / uv projects (no `requirements.txt`)
- [ ] More templates: Go, Rust, SvelteKit/Astro/Nuxt, static-site generators
- [ ] Build logs streamed to dashboard

**Core platform** (see root `ZYCLOUD-PLAN.md` for the accounts + federation initiative)

- [x] Shared zycloud account system — provider-agnostic `Account` + `AuthIdentity` + `Session` (replaces the GitHub-only Member model)
- [x] GitHub linked to the account as a `SourceConnection` (identity vs. deployment source decoupled; provider-agnostic, ready for GitLab/others)
- [ ] "Sign in with yangfrenz.club" — `core` as an OIDC Relying Party (federated login)
- [ ] Map yangfrenz membership → zycloud tier/role (friend perks)
- [ ] REST API (`src/routes/api/`) for separate dashboard and monitor frontends
- [ ] Branch previews (not just default branch)
- [ ] Delete CapRover app when repo is disconnected
- [ ] Per-member resource quotas on CapRover
- [ ] Custom subdomains under `yangfrenz.club` per member
- [ ] Web-based code editor (github.dev deep link or code-server sidecar)
- [ ] `yangfrenz.club` membership portal integration
