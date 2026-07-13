// Dev/prod run on PostgreSQL (schema.prisma → the default @prisma/client). The
// test suite runs on SQLite (schema.test.prisma), whose client is generated to
// a separate path so it never overwrites the PostgreSQL client. Pick the right
// one by DATABASE_PROVIDER — the test env sets it to "sqlite" (vitest.config.js).
const { PrismaClient } =
  process.env.DATABASE_PROVIDER === "sqlite"
    ? await import("../prisma/generated/test-client/index.js")
    : await import("@prisma/client");

export const prisma = new PrismaClient();
