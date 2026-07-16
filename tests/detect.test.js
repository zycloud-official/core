import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectFramework } from "../src/detect.js";

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "detect-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectFramework", () => {
  it("detects Dockerfile and emits a captain-definition pointing at it", async () => {
    await writeFile(join(dir, "Dockerfile"), "FROM node:20");
    const { framework, captainDef } = detectFramework(dir);
    expect(framework).toBe("dockerfile");
    expect(captainDef).toEqual({ schemaVersion: 1, dockerfilePath: "./Dockerfile" });
  });

  it("detects Vite via vite in dependencies", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { vite: "^5.0.0" } })
    );
    const { framework, captainDef } = detectFramework(dir);
    expect(framework).toBe("vite");
    expect(captainDef.dockerfileLines.some((l) => l.includes("nginx"))).toBe(true);
    expect(captainDef.dockerfileLines.some((l) => l.includes("/dist"))).toBe(true);
  });

  it("detects Vite via @vitejs/plugin-react in devDependencies", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { "@vitejs/plugin-react": "^4.0.0" } })
    );
    const { framework } = detectFramework(dir);
    expect(framework).toBe("vite");
  });

  it("detects Next.js", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "^14.0.0" } })
    );
    const { framework, captainDef } = detectFramework(dir);
    expect(framework).toBe("nextjs");
    expect(captainDef.dockerfileLines.some((l) => l.includes("npm run build"))).toBe(true);
    expect(captainDef.dockerfileLines.some((l) => l.includes("npm"))).toBe(true);
  });

  it("detects plain Node when package.json has no known framework", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { express: "^5.0.0" } })
    );
    const { framework, captainDef } = detectFramework(dir);
    expect(framework).toBe("node");
    expect(captainDef.dockerfileLines.some((l) => l.includes("index.js"))).toBe(true);
  });

  it("detects Python via requirements.txt", async () => {
    await writeFile(join(dir, "requirements.txt"), "flask\ngunicorn\n");
    const { framework, captainDef } = detectFramework(dir);
    expect(framework).toBe("python-flask");
    expect(captainDef.dockerfileLines.some((l) => l.includes("app.py"))).toBe(true);
  });

  it("detects static site via index.html", async () => {
    await writeFile(join(dir, "index.html"), "<!DOCTYPE html><html/>");
    const { framework, captainDef } = detectFramework(dir);
    expect(framework).toBe("static");
    expect(captainDef.dockerfileLines.some((l) => l.includes("nginx"))).toBe(true);
  });

  it("returns unknown with null captainDef for an empty directory", async () => {
    const { framework, captainDef } = detectFramework(dir);
    expect(framework).toBe("unknown");
    expect(captainDef).toBeNull();
  });

  it("Dockerfile takes priority over package.json", async () => {
    await writeFile(join(dir, "Dockerfile"), "FROM node:20");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "^14.0.0" } })
    );
    const { framework } = detectFramework(dir);
    expect(framework).toBe("dockerfile");
  });
});

// The generated Dockerfile must match the package manager the member committed,
// and must never run `npm ci` without a lockfile (it aborts). These assert the
// install/copy commands without needing a real Docker build.
describe("Node package-manager detection", () => {
  const lines = async (files) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.19.0" } })
    );
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body);
    }
    return detectFramework(dir).captainDef.dockerfileLines;
  };

  it("falls back to npm install (not npm ci) when no lockfile is present", async () => {
    const dl = await lines({});
    expect(dl).toContain("RUN npm install --omit=dev");
    expect(dl.some((l) => l.includes("npm ci"))).toBe(false);
    expect(dl).toContain("COPY package.json ./");
  });

  it("uses npm ci when package-lock.json is present", async () => {
    const dl = await lines({ "package-lock.json": "{}" });
    expect(dl).toContain("RUN npm ci --omit=dev");
    expect(dl).toContain("COPY package.json package-lock.json ./");
  });

  it("uses yarn (via corepack) when yarn.lock is present", async () => {
    const dl = await lines({ "yarn.lock": "" });
    expect(dl).toContain("RUN corepack enable");
    expect(dl).toContain("RUN yarn install --production --frozen-lockfile");
    expect(dl).toContain("COPY package.json yarn.lock ./");
  });

  it("uses pnpm (via corepack) when pnpm-lock.yaml is present", async () => {
    const dl = await lines({ "pnpm-lock.yaml": "" });
    expect(dl).toContain("RUN corepack enable");
    expect(dl).toContain("RUN pnpm install --prod --frozen-lockfile");
    expect(dl).toContain("COPY package.json pnpm-lock.yaml ./");
  });

  it("prefers yarn over npm when both lockfiles exist", async () => {
    const dl = await lines({ "yarn.lock": "", "package-lock.json": "{}" });
    expect(dl).toContain("RUN yarn install --production --frozen-lockfile");
    expect(dl.some((l) => l.includes("npm ci"))).toBe(false);
  });
});

// requirements.txt alone doesn't tell us how to run the app — Flask uses a dev
// server on :5000, FastAPI needs uvicorn on :8000, Django needs gunicorn against
// its wsgi module. These assert the right server/port without a Docker build.
describe("Python framework detection", () => {
  const write = async (files) => {
    for (const [name, body] of Object.entries(files)) {
      const full = join(dir, name);
      if (name.includes("/")) {
        await mkdir(join(full, ".."), { recursive: true });
      }
      await writeFile(full, body);
    }
    return detectFramework(dir).captainDef.dockerfileLines;
  };

  it("runs Flask via python app.py on :5000 when no web framework is detected", async () => {
    const dl = await write({ "requirements.txt": "flask\n" });
    expect(dl).toContain('CMD ["python", "app.py"]');
    expect(dl).toContain("EXPOSE 5000");
  });

  it("runs FastAPI via uvicorn on :8000, entry main:app", async () => {
    const dl = await write({
      "requirements.txt": "fastapi\nuvicorn\n",
      "main.py": "",
    });
    expect(dl).toContain(
      'CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]'
    );
    expect(dl).toContain("EXPOSE 8000");
  });

  it("falls back to app:app for FastAPI when main.py is absent", async () => {
    const dl = await write({ "requirements.txt": "fastapi\n", "app.py": "" });
    expect(dl).toContain(
      'CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]'
    );
  });

  it("runs Django via gunicorn against the wsgi module on :8000", async () => {
    const dl = await write({
      "requirements.txt": "django\ngunicorn\n",
      "manage.py": "",
      "mysite/wsgi.py": "",
    });
    expect(dl).toContain(
      'CMD ["gunicorn", "mysite.wsgi:application", "--bind", "0.0.0.0:8000"]'
    );
    expect(dl).toContain("EXPOSE 8000");
  });

  it("handles version specifiers and extras in requirements.txt", async () => {
    const dl = await write({
      "requirements.txt": "FastAPI>=0.110\nuvicorn[standard]==0.29.0\n",
      "main.py": "",
    });
    expect(dl).toContain(
      'CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]'
    );
  });
});
