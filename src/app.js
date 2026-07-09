import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { githubOAuthRoutes } from "./integrations/github/oauth.js";
import { githubWebhookRoutes } from "./integrations/github/webhook.js";
import { dashboardRoutes } from "./routes/dashboard.js";

const app = express();

// Allow the SPA (a separate origin) to call the API with the session cookie.
app.use(cors({ origin: process.env.APP_URL, credentials: true }));

// Parse JSON and capture raw bytes — required for webhook HMAC verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(cookieParser());

app.use(githubOAuthRoutes);
app.use(githubWebhookRoutes);
app.use(dashboardRoutes);

app.get("/health", (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

export default app;
