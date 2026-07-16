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

`src/detect.js` inspects an extracted repo and returns a `captain-definition`
(the Dockerfile CapRover builds). Detection runs **top-down, first match wins** —
order matters: any `package.json` falls through to the generic `node` template,
so new JS-framework templates must be inserted _above_ it.

| Match                    | Trigger                             | Build target                         | Port       |
| ------------------------ | ----------------------------------- | ------------------------------------ | ---------- |
| `dockerfile`             | `Dockerfile` present                | used as-is                           | repo's own |
| `vite`                   | `vite` / `@vitejs/plugin-*` in deps | multi-stage build → nginx            | 80         |
| `nextjs`                 | `next` in deps                      | build + start                        | 3000       |
| `node`                   | any other `package.json`            | install prod deps → `node index.js`  | 3000       |
| `python` — Django        | `django` in reqs or `manage.py`     | `gunicorn <pkg>.wsgi`                | 8000       |
| `python` — FastAPI       | `fastapi` in reqs                   | `uvicorn main:app` (else `app:app`)  | 8000       |
| `python` — Flask/generic | `requirements.txt` only             | `python app.py`                      | 5000       |
| `static`                 | `index.html` present                | nginx serves files                   | 80         |
| `unknown`                | none of the above                   | `null` — deploy proceeds without one | —          |

Node templates are **package-manager-aware**: the generated Dockerfile uses
npm / yarn / pnpm based on the committed lockfile, and falls back to
`npm install` when none is present (`npm ci` aborts without a lockfile).

**Adding a template:** add a `<fw>Def(dir)` builder + detection branch in
`detect.js`, then add a fixture under `tests/fixtures/<fw>/` — a minimal but
_real_ app whose `/` responds `hello from <fw>`. Wire it into both test tiers,
then run the build tier: if the image builds and serves, the template is proven.

### Known gaps

- **Python entrypoint/port are conventions, not detected** — Flask is assumed to
  be `app.py` on `:5000`; a non-conventional layout still slips through.
- **No `pyproject.toml` / poetry / uv detection** — Python projects without a
  `requirements.txt` are currently classified `unknown`.
- **Long tail of JS frameworks** (SvelteKit, Astro, Nuxt, Remix, CRA, Angular)
  falls through to the generic `node` template and will mostly fail to build.
- **Detection is a guess, not a member choice** — planned fix: build-pack presets
  (see [App Configuration](#app-configuration-planned) below) turn `detectFramework`
  into an advisory suggestion only; the deploy pipeline uses the member's explicit
  pick instead of guessing.

---

## App Configuration (planned)

Every connected app currently deploys on a guess: `detect.js` inspects the repo and
picks a framework template, the CapRover app name is derived from `{owner}-{repo}`,
env vars are never sent to CapRover at all, and the webhook only ever deploys pushes
to the repo's default branch. `AppConfig` (schema) exists today as an empty stub —
just `id`/`appId`/timestamps — auto-created on connect (`config: { create: {} }` in
`github.js`), which means the webhook's `!app.config` gate is currently a no-op.

Fields to add, in priority order. `buildPack`/`targetBranch`/`codename` are required
scalar columns on `AppConfig` — the connect form can't submit without them. Env vars
are **optional**: they live in their own `EnvVar` table related to `AppConfig`, so
zero rows is a valid, common state (e.g. a static site needs none) — no NOT NULL/
required handling needed for that, unlike the other three.

- **`buildPack`** (String, required, no default) — replaces guess-based detection
  with an explicit member choice from a fixed preset list (`dockerfile`, `vite`,
  `nextjs`, `node`, `python-django`, `python-fastapi`, `python-flask`, `static`).
  **v1 has no auto-suggestion** — the connect form just lists all presets and the
  member picks one; `detect.js`'s guessing is not wired into the picker yet (that
  would need a new endpoint to fetch repo contents before the form even opens —
  deferred, see Known issues). `deploy.js` stops calling `detectFramework` to
  decide the template and instead looks up the chosen buildpack's `captainDef(dir)`
  builder directly. A repo's own `captain-definition`, if present, still wins over
  any buildpack (unchanged from today).
- **`targetBranch`** (String, required — pre-filled with the repo's `default_branch`
  at connect time, but overridable) — `webhook.js`'s `handlePush` currently
  hardcodes `ref !== refs/heads/${repository.default_branch}`; this needs to check
  `app.config.targetBranch` instead, which means looking up `app` + `config`
  *before* the branch check, not after (today the app lookup happens later, purely
  to decide whether to deploy at all).
- **`codename`** (String, unique, required) — replaces the `{owner}-{repo}`
  derivation for both `caproverAppName` and `previewUrl` (becomes
  `https://{codename}.zycloud.space`). Needs a slug validator (CapRover app-name
  rules: lowercase, alphanumeric + hyphen) plus a reserved-word check (see Known
  issues) and a **global** uniqueness check (not just per-account) run before
  saving — surfaced as a live availability check in the connect UI, but the DB
  unique constraint is the real guard (the API must handle a unique-violation on
  write as a 409, since the UI's live check can't close the race with a
  same-instant duplicate submission).
  **Renaming after first deploy:** decided to support it via CapRover's own
  `POST /api/v2/user/apps/appDefinitions/rename` (`{oldAppName, newAppName}`),
  traced through CapRover's current source
  (`ServiceManager.renameApp` / `AppsDataStore.renameApp`) rather than assumed from
  docs (this endpoint isn't in CapRover's public API docs at all). It: requires the
  old app's Docker service to currently be running (throws otherwise) → removes
  that service → renames the stored app definition → recreates the service under
  the new name → re-enables SSL if it was on. Concretely: **brief downtime is
  guaranteed** (steps are sequential, not atomic) and **there's no rollback** if a
  later step fails after the old service has already been removed. Our side must:
  only allow renaming while the app's service is actually running, and only update
  our own `codename` column *after* CapRover's rename call succeeds — never assume
  success. (Two old CapRover GitHub issues, #490/#701, reported renames deleting
  apps outright; both are 2019–2021, closed as stale/unreproducible, and current
  source looks materially more careful — but there's no changelog confirming a fix,
  so treat this as a real, if unlikely, failure mode.)
- **Env vars** (optional — zero is valid) — a separate `EnvVar` model (`key`,
  `value`, `secret: Boolean`, `keyVersion: Int @default(1)`, `appConfigId`) rather
  than a JSON blob on `AppConfig`. `value` is **encrypted at rest**, not plaintext
  — see [Env var secret encryption](#env-var-secret-encryption-planned) below.
  `caprover.js` needs a new call (or an extended `enableSsl`-style `update`) that
  sends `envVars: [{key, value}]` (decrypted just-in-time) on every deploy — an
  empty array is fine and just means no env vars are set.

### Pipeline changes this implies

- `github.js`'s `POST /apps` stays a **single endpoint**, but its request body
  grows to carry `buildPack`/`targetBranch`/`codename`/env vars, and it creates
  `App` + a fully-populated `AppConfig` (+ `EnvVar` rows) together in one
  request/transaction — no separate "configure" endpoint or follow-up call.
  `AppConfig` is only ever created with these fields present (never empty), which
  makes the webhook's `!app.config` gate meaningful instead of a no-op.
- `deploy.js`: drop the `detectFramework` call in favor of
  `buildPacks[app.config.buildPack]`; use `app.config.codename` instead of the
  owner/repo-derived `appName` for CapRover create/upload/SSL calls; derive
  `containerHttpPort` from the buildpack instead of the hardcoded `80` (see Known
  issues); send decrypted env vars alongside the tarball upload.
- `detect.js`: reshape from "guess and return a template" into a keyed
  `buildPacks` registry — for v1 this registry is consumed directly by
  `deploy.js`'s explicit lookup only; the guess/suggestion path is not wired up.
  This changes `detectFramework`'s exported shape, which will break the existing
  detection snapshot tests (`tests/detect*.test.js`) — not a drop-in refactor,
  budget time to update those fixtures/snapshots alongside it.
- `ConnectRepoModal.tsx` / dashboard (`app/`): the **UI** changes, not the API
  shape — clicking "Connect" on a repo opens a form (buildpack picker listing all
  presets, codename field with availability check, branch dropdown, env var
  key/value list editor) instead of firing `connectRepo` immediately; submitting
  the form is still the one `POST /apps` call.

**Status:** planned, not started. Tracked in the Roadmap below.

### Env var secret encryption (planned)

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

Caught while reading the existing pipeline; noted here rather than fixed silently
as a side effect of this feature, since some predate it:

- **`containerHttpPort` is hardcoded to `80`** in `caprover.js`'s `enableSsl`, for
  every app regardless of framework. Fine for the `vite`/`static` templates
  (nginx really listens on 80), but Next.js (3000) and the Python templates
  (8000/5000) would get CapRover routing to the wrong internal port — deploys
  likely "succeed" while the app stays unreachable. Fix: derive
  `containerHttpPort` from `buildPack` once that field lands.
- **A bare `Dockerfile` with no committed `captain-definition` currently deploys
  with neither.** `detect.js` returns `captainDef: null` for the `dockerfile`
  case ("use as-is"), but `deploy.js` only writes a `captain-definition` when
  `captainDef` is truthy — nothing gets injected, and CapRover generally needs
  that file to know to build from the Dockerfile. The `dockerfile` buildpack
  preset should emit `{"schemaVersion":1,"dockerfilePath":"./Dockerfile"}`
  itself rather than inheriting this gap.
- **`codename`'s model home is undecided** — drafted above as an `AppConfig`
  field, but it's arguably identity (it replaces `App.caproverAppName`/
  `previewUrl`), not deploy *behavior*, which is what the rest of `AppConfig`
  covers. Decide before writing the migration.
- **This plan only covers creation, not editing.** Env vars especially will need
  rotation/updates later (codename already has a rename path above, but
  `buildPack`/`targetBranch`/env vars have no `PATCH` endpoint or edit UI in
  scope yet — connect-time only).
- **Codename slugs need a reserved-word list** — `www`, `api`, `app`, `core`,
  `captain`, etc. must be blocked so a member can't claim a subdomain that
  collides with zycloud's own infra.
- **Buildpack auto-suggestion needs plumbing that doesn't exist** — deferred for
  v1 (see `buildPack` above), but noting it stays open: today's `GET
  /github/repos` only returns GitHub metadata, never repo contents.

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

**Next up — App Configuration** (see [App Configuration](#app-configuration-planned) above)

- [ ] `AppConfig.buildPack` — build-pack presets, replacing guess-based detection; v1 lists all presets, no auto-suggestion
- [ ] `AppConfig.targetBranch` — configurable deploy branch (currently hardcoded to default branch)
- [ ] `AppConfig.codename` — member-chosen subdomain prefix, replacing `{owner}-{repo}`; global availability check before save; rename supported later via CapRover's `appDefinitions/rename`
- [ ] `EnvVar` model (optional — zero is valid), **encrypted at rest** (see [Env var secret encryption](#env-var-secret-encryption-planned)) + wiring env vars into the CapRover upload/update calls
- [ ] Connect UI shows a form (buildpack/branch/codename/env vars) before submitting; `POST /apps` stays one endpoint, one request
- [ ] Fix `containerHttpPort` hardcoded to `80` — derive from `buildPack` (known bug, see Known issues)
- [ ] Fix bare-`Dockerfile`-with-no-`captain-definition` deploying with neither (known gap, see Known issues)

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
