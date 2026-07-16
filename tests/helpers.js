import { prisma } from "../src/db.js";

// Call at the start of beforeEach in any test file that writes to the DB.
export async function cleanDb() {
  await prisma.deploy.deleteMany();
  await prisma.envVar.deleteMany();
  await prisma.appConfig.deleteMany();
  await prisma.app.deleteMany();
  await prisma.sourceConnection.deleteMany();
  await prisma.session.deleteMany();
  await prisma.authIdentity.deleteMany();
  await prisma.account.deleteMany();
}
