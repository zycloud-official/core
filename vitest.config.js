import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
    env: {
      DATABASE_URL: "file:./data/test.db",
      DATABASE_PROVIDER: "sqlite",
      GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
      GITHUB_APP_SLUG: "test-app",
      BASE_URL: "https://example.com",
      APP_URL: "https://app.example.com",
      CAPROVER_URL: "https://captain.example.com",
      CAPROVER_PASSWORD: "test-password",
      ENV_VAR_ENCRYPTION_KEY: "cWlOgZJt4apdu5r3ylfAzTYeVX0N5I9D0MBXHPeq56o=",
    },
    globalSetup: "./tests/global-setup.js",
    setupFiles: ["./tests/setup.js"],
    // All test files share one SQLite DB — run them sequentially in one worker
    // to avoid concurrent read/write races between files.
    fileParallelism: false,
  },
});
