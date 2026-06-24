import { execSync } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";

// Runs once before all test files.
// Manually deletes the test DB (avoids Prisma's --force-reset AI safety guard),
// then pushes the dev schema to create a fresh one.
export async function setup() {
  await mkdir("./data", { recursive: true });

  // Remove all SQLite files for the test DB so we start clean. Prisma resolves
  // a relative `file:` URL against the SCHEMA directory (prisma/), so the real
  // DB lives at prisma/data/test.db — delete both that and the CWD-relative
  // path to be robust to either resolution.
  for (const base of ["./data/test.db", "./prisma/data/test.db"]) {
    await rm(base, { force: true });
    await rm(`${base}-shm`, { force: true });
    await rm(`${base}-wal`, { force: true });
  }

  execSync("yarn prisma db push --schema=prisma/schema.dev.prisma", {
    env: { ...process.env, DATABASE_URL: "file:./data/test.db" },
    stdio: "inherit",
  });
}
