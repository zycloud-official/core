import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";

// Provider-agnostic session handling for zycloud accounts. A session is an
// opaque random token stored in the `sessions` table and delivered as an
// httpOnly cookie — login providers (GitHub, yangfrenz) call createSession once
// they've resolved the Account, so cookie/session logic lives in one place.

const COOKIE = "session";
const TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

const cookieOpts = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: TTL_MS,
};

// Mint a session for an account and set the cookie. Returns the raw token.
export async function createSession(res, accountId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_MS);
  await prisma.session.create({ data: { token, accountId, expiresAt } });
  res.cookie(COOKIE, token, cookieOpts);
  return token;
}

// Revoke the session behind `token` (if any) and clear the cookie.
export async function clearSession(res, token) {
  if (token) await prisma.session.deleteMany({ where: { token } });
  res.clearCookie(COOKIE, { path: "/" });
}

// Resolve the session cookie → Session → Account and attach `req.account`
// (null when absent/expired). Non-blocking: always calls next().
export async function loadSession(req, _res, next) {
  req.account = null;
  const token = req.cookies?.[COOKIE];
  if (token) {
    const session = await prisma.session.findUnique({
      where: { token },
      include: { account: true },
    });
    if (session && session.expiresAt > new Date()) {
      req.account = session.account;
      req.sessionToken = token;
    }
  }
  next();
}

// Guard for routes that require a signed-in account. Responds 401 JSON —
// callers are the SPA's fetch() calls, which can't usefully follow a redirect
// into GitHub's OAuth flow; the SPA routes the user to login itself.
export function requireSession(req, res, next) {
  if (!req.account) return res.status(401).json({ error: "Not authenticated" });
  next();
}
