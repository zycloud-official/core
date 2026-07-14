import { App } from "@octokit/app";

export const githubApp = new App({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  webhooks: { secret: process.env.GITHUB_WEBHOOK_SECRET },
  oauth: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },
});

// Minimal GitHub REST call authenticated with a user-to-server OAuth token
// (the one captured at login). Throws with `.status` set so callers can map
// 401 → "re-authenticate".
async function githubUserApi(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "zycloud-core/1.0",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${path} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// The GitHub App installations the logged-in user can access. This is how we
// discover a member's repos without depending on webhook-delivered install
// events (which never reach a local dev server).
export async function listUserInstallations(token) {
  const data = await githubUserApi("/user/installations?per_page=100", token);
  return data.installations ?? [];
}

// Repos the user can access within a single installation (paginated).
export async function listUserInstallationRepos(installationId, token) {
  const repos = [];
  for (let page = 1; ; page++) {
    const data = await githubUserApi(
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      token
    );
    repos.push(...data.repositories);
    if (data.repositories.length < 100) break;
  }
  return repos;
}

export async function downloadTarball(owner, repo, sha, installationId) {
  console.log(
    `[github] Getting installation token (installationId: ${installationId})`
  );
  const octokit = await githubApp.getInstallationOctokit(installationId);
  const { token } = await octokit.auth({
    type: "installation",
    installationId,
  });

  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
  console.log(`[github] Downloading tarball: ${url}`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "zycloud-core/1.0",
    },
    redirect: "follow",
  });
  if (!res.ok)
    throw new Error(`Tarball download failed: ${res.status} ${res.statusText}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  console.log(
    `[github] Tarball downloaded: ${(buffer.length / 1024).toFixed(1)} KB`
  );
  return buffer;
}
