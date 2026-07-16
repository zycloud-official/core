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
  if (!res.ok) throw new Error(`CapRover login failed: ${res.status}`);
  const { data } = await res.json();
  cachedToken = data.token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  console.log("[caprover] Authenticated (token cached for 50 min)");
  return cachedToken;
}

async function api(method, path, body) {
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
  if (!res.ok) throw new Error(`CapRover ${method} ${path} → ${res.status}`);
  return res.json();
}

// Returns the full CapRover app definition, or null if the app doesn't exist.
// Callers can inspect .hasDefaultSubDomainSsl to check SSL status.
export async function getAppDefinition(appName) {
  console.log(`[caprover] Fetching app definition: ${appName}`);
  const { data } = await api("GET", "/user/apps/appDefinitions");
  const app = data.appDefinitions.find((a) => a.appName === appName) ?? null;
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
