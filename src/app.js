import express from "express";
import cookieParser from "cookie-parser";
import { githubOAuthRoutes } from "./integrations/github/oauth.js";
import { githubWebhookRoutes } from "./integrations/github/webhook.js";
import { dashboardRoutes } from "./routes/dashboard.js";

const app = express();

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
