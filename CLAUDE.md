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
