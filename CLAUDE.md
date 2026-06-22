# github-integration

A Netlify-style deployment platform for yangfrenz.club members, powered by a GitHub App and CapRover. Members connect their GitHub repos, and every push to the default branch automatically builds and deploys their app — no CLI, no credentials to manage.

Deployed at `github-integration.zycloud.space` on the **zycloud** CapRover instance. Member apps are served at `https://{owner}-{repo}.zycloud.space`.

**Package manager: yarn** — use `yarn` for all installs and script runs. Do not use `npm` or `npx`; use `yarn` equivalents instead.

---

## File map

| File | Purpose |
|------|---------|
| `src/index.js` | Server entry — boots `app.js` and listens |
| `src/app.js` | Express app — middleware and route registration |
| `src/db.js` | Prisma client singleton |
| `src/caprover.js` | CapRover API client (login, create app, upload, SSL) |
| `src/detect.js` | Framework detection → generates `captain-definition` (see [Framework templates](#framework-templates)) |
| `src/deploy.js` | Deploy pipeline: download → extract → inject → repack → upload |
| `src/integrations/github/client.js` | GitHub App instance + `downloadTarball` |
| `src/integrations/github/oauth.js` | GitHub OAuth: `GET /auth/github`, `/auth/callback`, `POST /auth/logout` (`githubOAuthRoutes`) |
| `src/integrations/github/webhook.js` | `POST /webhook` — HMAC verify + event handlers (`githubWebhookRoutes`) |
| `src/routes/dashboard.js` | `GET /dashboard` — member apps + deploy status |
| `prisma/schema.prisma` | Production schema (PostgreSQL) |
| `prisma/schema.dev.prisma` | Development schema (SQLite) |
| `tests/fixtures/` | Per-framework sample apps for detection + build tests |
| `scripts/start.sh` | Container entrypoint — runs `prisma db push` then starts server |

> GitHub-specific code (App client, OAuth, webhook) lives under
> `src/integrations/github/` per the [module boundaries](#module-boundaries) —
> it must not contain deploy logic. `src/deploy.js` and `src/caprover.js` stay
> provider-agnostic.

---

## Local dev

```bash
cp .env.example .env
yarn install
yarn dev:db:generate   # generate Prisma client from SQLite schema
yarn dev:db:push       # create/sync local DB
yarn dev
```

Use `yarn dev:db:studio` to browse the DB. Use smee.io or ngrok to receive webhooks locally.

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
*(Planned: a per-push workflow running the fast tier.)*

---

## Framework templates

`src/detect.js` inspects an extracted repo and returns a `captain-definition`
(the Dockerfile CapRover builds). Detection runs **top-down, first match wins** —
order matters: any `package.json` falls through to the generic `node` template,
so new JS-framework templates must be inserted *above* it.

| Match | Trigger | Build target | Port |
|-------|---------|--------------|------|
| `dockerfile` | `Dockerfile` present | used as-is | repo's own |
| `vite` | `vite` / `@vitejs/plugin-*` in deps | multi-stage build → nginx | 80 |
| `nextjs` | `next` in deps | build + start | 3000 |
| `node` | any other `package.json` | install prod deps → `node index.js` | 3000 |
| `python` — Django | `django` in reqs or `manage.py` | `gunicorn <pkg>.wsgi` | 8000 |
| `python` — FastAPI | `fastapi` in reqs | `uvicorn main:app` (else `app:app`) | 8000 |
| `python` — Flask/generic | `requirements.txt` only | `python app.py` | 5000 |
| `static` | `index.html` present | nginx serves files | 80 |
| `unknown` | none of the above | `null` — deploy proceeds without one | — |

Node templates are **package-manager-aware**: the generated Dockerfile uses
npm / yarn / pnpm based on the committed lockfile, and falls back to
`npm install` when none is present (`npm ci` aborts without a lockfile).

**Adding a template:** add a `<fw>Def(dir)` builder + detection branch in
`detect.js`, then add a fixture under `tests/fixtures/<fw>/` — a minimal but
*real* app whose `/` responds `hello from <fw>`. Wire it into both test tiers,
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

| Var | Description |
|-----|-------------|
| `PORT` | Server port (default `3000`) |
| `BASE_URL` | `https://github-integration.zycloud.space` |
| `DATABASE_PROVIDER` | `sqlite` (local) or `postgres` (production) |
| `DATABASE_URL` | SQLite: `file:./data/zycloud.db` — Postgres: full connection string |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key with literal `\n` for newlines |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret from GitHub App settings |
| `GITHUB_CLIENT_ID` | OAuth client ID |
| `GITHUB_CLIENT_SECRET` | OAuth client secret |
| `GITHUB_APP_SLUG` | App URL slug (e.g. `github-integration`) |
| `CAPROVER_URL` | `https://captain.zycloud.space` |
| `CAPROVER_PASSWORD` | CapRover admin password |

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

| Module | Owns |
|--------|------|
| `src/routes/auth.js` | Zycloud account login/logout/session |
| `src/integrations/github/` | GitHub App, OAuth, webhook handling — no deploy logic |
| `src/deploy.js` | Provider-agnostic deploy pipeline |
| `src/caprover.js` | CapRover API — no integration-specific concepts |
| `src/routes/api/` | REST endpoints for dashboard and other frontend apps |

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

**Core platform**

- [ ] Shared zycloud account system (replaces GitHub-only Member model)
- [ ] GitHub integration linked to zycloud account (not standalone)
- [ ] REST API (`src/routes/api/`) for separate dashboard and monitor frontends
- [ ] Branch previews (not just default branch)
- [ ] Delete CapRover app when repo is disconnected
- [ ] Per-member resource quotas on CapRover
- [ ] Custom subdomains under `yangfrenz.club` per member
- [ ] Web-based code editor (github.dev deep link or code-server sidecar)
- [ ] `yangfrenz.club` membership portal integration
