import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Detect the project framework from a directory and return the matching
 * buildPacks key + captain-definition. This is the advisory/guess path —
 * not wired into the connect flow yet (members pick a buildPack explicitly);
 * kept for a future auto-suggestion feature, built on the same registry
 * `deploy.js` uses for the explicit lookup.
 */
export function detectFramework(dir) {
  const key = detectBuildPackKey(dir);
  if (key === "unknown") {
    return { framework: "unknown", captainDef: null };
  }
  return { framework: key, captainDef: buildPacks[key].captainDef(dir) };
}

function detectBuildPackKey(dir) {
  if (existsSync(join(dir, "Dockerfile"))) {
    return "dockerfile";
  }

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {}
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (
      "vite" in deps ||
      "@vitejs/plugin-react" in deps ||
      "@vitejs/plugin-vue" in deps
    ) {
      return "vite";
    }
    if ("next" in deps) {
      return "nextjs";
    }
    return "node";
  }

  if (existsSync(join(dir, "requirements.txt"))) {
    const deps = readRequirements(dir);
    const has = (name) => deps.includes(name);
    if (has("django") || existsSync(join(dir, "manage.py"))) return "python-django";
    if (has("fastapi")) return "python-fastapi";
    return "python-flask";
  }

  if (existsSync(join(dir, "index.html"))) {
    return "static";
  }

  return "unknown";
}

/**
 * Pick install tooling from the lockfile committed in `dir`. CapRover builds the
 * repo as-is, so the generated Dockerfile must use whatever package manager the
 * member uses — and must not assume a lockfile exists (`npm ci` aborts without
 * one, which previously broke every lockfile-less Node repo).
 *
 * @param {string} dir
 * @param {{ dev: boolean }} opts  dev=true keeps devDependencies (needed to build)
 * @returns {{ setup: string[], copy: string, install: string, run: string }}
 */
function nodePackaging(dir, { dev }) {
  const has = (f) => existsSync(join(dir, f));

  if (has("yarn.lock")) {
    return {
      setup: ["RUN corepack enable"],
      copy: "COPY package.json yarn.lock ./",
      install: dev
        ? "RUN yarn install --frozen-lockfile"
        : "RUN yarn install --production --frozen-lockfile",
      run: "yarn",
    };
  }
  if (has("pnpm-lock.yaml")) {
    return {
      setup: ["RUN corepack enable"],
      copy: "COPY package.json pnpm-lock.yaml ./",
      install: dev
        ? "RUN pnpm install --frozen-lockfile"
        : "RUN pnpm install --prod --frozen-lockfile",
      run: "pnpm",
    };
  }
  if (has("package-lock.json")) {
    return {
      setup: [],
      copy: "COPY package.json package-lock.json ./",
      install: dev ? "RUN npm ci" : "RUN npm ci --omit=dev",
      run: "npm run",
    };
  }
  // No lockfile — `npm ci` would abort, so fall back to `npm install`.
  return {
    setup: [],
    copy: "COPY package.json ./",
    install: dev ? "RUN npm install" : "RUN npm install --omit=dev",
    run: "npm run",
  };
}

function dockerfileDef() {
  // The repo already committed its own Dockerfile — CapRover just needs to be
  // told to build from it (see deploy.js, which only writes a captain-definition
  // when the repo doesn't already have one committed).
  return { schemaVersion: 1, dockerfilePath: "./Dockerfile" };
}

function viteDef(dir) {
  const p = nodePackaging(dir, { dev: true });
  return {
    schemaVersion: 2,
    dockerfileLines: [
      // node:20-alpine (musl) causes esbuild to produce a non-extensible module
      // object that breaks Vite's config loader. Use Debian slim instead.
      "FROM node:lts-slim AS builder",
      "WORKDIR /app",
      ...p.setup,
      p.copy,
      p.install,
      "COPY . .",
      `RUN ${p.run} build`,
      "FROM nginx:alpine",
      "COPY --from=builder /app/dist /usr/share/nginx/html",
      // Single-quoted string keeps $uri literal (no shell expansion). Overwrites nginx default
      // with SPA-friendly config so client-side routing works on any path.
      "RUN echo 'server{listen 80;root /usr/share/nginx/html;index index.html;location /{try_files $uri $uri/ /index.html;}}' > /etc/nginx/conf.d/default.conf",
      "EXPOSE 80",
    ],
  };
}

function nextjsDef(dir) {
  const p = nodePackaging(dir, { dev: true });
  return {
    schemaVersion: 2,
    dockerfileLines: [
      "FROM node:lts-slim",
      "WORKDIR /app",
      ...p.setup,
      p.copy,
      p.install,
      "COPY . .",
      `RUN ${p.run} build`,
      "EXPOSE 3000",
      `CMD ${p.run} start`,
    ],
  };
}

function nodeDef(dir) {
  const p = nodePackaging(dir, { dev: false });
  return {
    schemaVersion: 2,
    dockerfileLines: [
      "FROM node:lts-slim",
      "WORKDIR /app",
      ...p.setup,
      p.copy,
      p.install,
      "COPY . .",
      "EXPOSE 3000",
      'CMD ["node", "index.js"]',
    ],
  };
}

/**
 * Read the dependency names from requirements.txt (lowercased, version/extras
 * specifiers stripped) so we can pick the right server and port per framework.
 */
function readRequirements(dir) {
  let raw = "";
  try {
    raw = readFileSync(join(dir, "requirements.txt"), "utf8");
  } catch {}
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[<>=~!;[\s]/)[0].toLowerCase())
    .filter(Boolean);
}

/**
 * Find the Django project package (the directory holding wsgi.py) so gunicorn
 * can target `<package>.wsgi:application`. Returns null if none is found.
 */
function findDjangoWsgiModule(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, "wsgi.py"))) {
      return entry.name;
    }
  }
  return null;
}

function pythonImage(port, cmdLine) {
  return {
    schemaVersion: 2,
    dockerfileLines: [
      "FROM python:3.12-slim",
      "WORKDIR /app",
      "COPY requirements.txt ./",
      "RUN pip install --no-cache-dir -r requirements.txt",
      "COPY . .",
      `EXPOSE ${port}`,
      cmdLine,
    ],
  };
}

// Django — served by gunicorn against the project's wsgi module on :8000.
function djangoDef(dir) {
  const module = findDjangoWsgiModule(dir) ?? "wsgi";
  const target = module === "wsgi" ? "wsgi:application" : `${module}.wsgi:application`;
  return pythonImage(8000, `CMD ["gunicorn", "${target}", "--bind", "0.0.0.0:8000"]`);
}

// FastAPI — an ASGI app served by uvicorn on :8000. Entry module is main.py
// by convention, falling back to app.py; the app object is conventionally `app`.
function fastapiDef(dir) {
  const module = existsSync(join(dir, "main.py")) ? "main" : "app";
  return pythonImage(
    8000,
    `CMD ["uvicorn", "${module}:app", "--host", "0.0.0.0", "--port", "8000"]`
  );
}

// Generic / Flask dev server — runs app.py directly on :5000.
function flaskDef() {
  return pythonImage(5000, 'CMD ["python", "app.py"]');
}

function staticDef() {
  return {
    schemaVersion: 2,
    dockerfileLines: [
      "FROM nginx:alpine",
      "COPY . /usr/share/nginx/html",
      "EXPOSE 80",
    ],
  };
}

// Single source of truth for build-pack behavior: the captain-definition
// builder and the CapRover container port per preset. `deploy.js` looks this
// up explicitly by the member's chosen buildPack; `detectFramework` above
// consumes the same registry for its (currently unwired) guess path.
export const buildPacks = {
  dockerfile: { captainDef: dockerfileDef, containerHttpPort: 80 },
  vite: { captainDef: viteDef, containerHttpPort: 80 },
  nextjs: { captainDef: nextjsDef, containerHttpPort: 3000 },
  node: { captainDef: nodeDef, containerHttpPort: 3000 },
  "python-django": { captainDef: djangoDef, containerHttpPort: 8000 },
  "python-fastapi": { captainDef: fastapiDef, containerHttpPort: 8000 },
  "python-flask": { captainDef: flaskDef, containerHttpPort: 5000 },
  static: { captainDef: staticDef, containerHttpPort: 80 },
};
