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
    },
    globalSetup: "./tests/global-setup.js",
    setupFiles: ["./tests/setup.js"],
    // All test files share one SQLite DB — run them sequentially in one worker
    // to avoid concurrent read/write races between files.
    fileParallelism: false,
  },
});
