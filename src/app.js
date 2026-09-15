import express from "express";
import helmet from "helmet";
import { checkDatabaseConnection } from "./db.js";
import licenseRoutes from "./license-routes.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "Allm4 License Server",
    status: "online",
  });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "allm4-license-server",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health/db", async (_req, res) => {
  try {
    const now = await checkDatabaseConnection();
    res.status(200).json({
      ok: true,
      database: "connected",
      databaseTime: now,
    });
  } catch (error) {
    console.error("Database health check failed", error);
    res.status(503).json({
      ok: false,
      database: "unavailable",
    });
  }
});

app.use(licenseRoutes);

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "not_found",
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({
      ok: false,
      error: "invalid_json",
    });
  }

  console.error("Unhandled request error", error);
  return res.status(500).json({
    ok: false,
    error: "internal_error",
  });
});

export default app;
