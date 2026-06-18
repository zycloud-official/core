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

export async function downloadTarball(owner, repo, sha, installationId) {
  console.log(`[github] Getting installation token (installationId: ${installationId})`);
  const octokit = await githubApp.getInstallationOctokit(installationId);
  const { token } = await octokit.auth({ type: "installation", installationId });

  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
  console.log(`[github] Downloading tarball: ${url}`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "github-integration/1.0",
    },
    redirect: "follow",
  });
  if (!res.ok)
    throw new Error(`Tarball download failed: ${res.status} ${res.statusText}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  console.log(`[github] Tarball downloaded: ${(buffer.length / 1024).toFixed(1)} KB`);
  return buffer;
}
