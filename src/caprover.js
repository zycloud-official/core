const BASE = process.env.CAPROVER_URL;
const PASSWORD = process.env.CAPROVER_PASSWORD;

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  console.log("[caprover] Authenticating...");
  const res = await fetch(`${BASE}/api/v2/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-namespace": "captain" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CapRover login failed: ${res.status}: ${text.slice(0, 300)}`);
  const { data } = JSON.parse(text);
  cachedToken = data.token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  console.log("[caprover] Authenticated (token cached for 50 min)");
  return cachedToken;
}

// CapRover's captain service occasionally returns transient errors (429 while
// another operation holds its internal lock, 502/503/504 if it's briefly
// overloaded) — retry those a couple of times with backoff instead of failing
// the whole deploy on one flaky response.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

async function api(method, path, body, attempt = 1) {
  const token = await getToken();
  const res = await fetch(`${BASE}/api/v2${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-namespace": "captain",
      "x-captain-auth": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();

  if (!res.ok) {
    if (RETRYABLE_STATUSES.has(res.status) && attempt < 3) {
      const delayMs = attempt * 3000;
      console.warn(
        `[caprover] ${method} ${path} → ${res.status}, retrying in ${delayMs}ms (attempt ${attempt}/2): ${text.slice(0, 300)}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return api(method, path, body, attempt + 1);
    }
    throw new Error(`CapRover ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`CapRover ${method} ${path} returned non-JSON response: ${text.slice(0, 300)}`);
  }
}

// Returns the full CapRover app definition, or null if the app doesn't exist.
// Callers can inspect .hasDefaultSubDomainSsl to check SSL status.
export async function getAppDefinition(appName) {
  console.log(`[caprover] Fetching app definition: ${appName}`);
  const result = await api("GET", "/user/apps/appDefinitions");
  const appDefinitions = result?.data?.appDefinitions;
  if (!Array.isArray(appDefinitions)) {
    throw new Error(`CapRover returned an unexpected appDefinitions response: ${JSON.stringify(result).slice(0, 300)}`);
  }
  const app = appDefinitions.find((a) => a.appName === appName) ?? null;
  console.log(`[caprover] App ${appName}: ${app ? `exists (ssl=${app.hasDefaultSubDomainSsl})` : "not found"}`);
  return app;
}

export async function createApp(appName) {
  console.log(`[caprover] Creating app: ${appName}`);
  await api("POST", "/user/apps/appDefinitions/register", { appName, hasPersistentData: false });
  console.log(`[caprover] App created: ${appName}`);
}

export async function enableSsl(appName) {
  console.log(`[caprover] Enabling SSL for: ${appName}`);
  await api("POST", "/user/apps/appDefinitions/enablebasedomainssl", { appName });
  console.log(`[caprover] SSL enabled for: ${appName}`);
}

// Pushes the buildpack's containerHttpPort and the app's env vars to CapRover.
// Runs on every deploy (not just the first), since env vars can be empty/added
// over time and the port depends on the member's chosen buildPack.
export async function updateAppDefinition(appName, { containerHttpPort, envVars = [] }) {
  console.log(
    `[caprover] Updating app definition for: ${appName} (port ${containerHttpPort}, ${envVars.length} env var(s))`
  );
  await api("POST", "/user/apps/appDefinitions/update", {
    appName,
    forceSsl: true,
    websocketSupport: false,
    containerHttpPort,
    notExposeAsWebApp: false,
    description: "",
    envVars,
  });
  console.log(`[caprover] App definition updated for: ${appName}`);
}

export async function uploadTarball(appName, tarballBuffer) {
  console.log(`[caprover] Uploading ${(tarballBuffer.length / 1024).toFixed(1)} KB tarball for: ${appName}`);
  const token = await getToken();
  const form = new FormData();
  form.append(
    "sourceFile",
    new Blob([tarballBuffer], { type: "application/gzip" }),
    "app.tar.gz"
  );

  const res = await fetch(
    `${BASE}/api/v2/user/apps/appData/${appName}?detached=1`,
    {
      method: "POST",
      headers: { "x-namespace": "captain", "x-captain-auth": token },
      body: form,
    }
  );
  if (!res.ok) throw new Error(`CapRover upload failed: ${res.status}`);
  const result = await res.json();
  console.log(`[caprover] Upload accepted for: ${appName}`);
  return result;
}
