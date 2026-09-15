import express from "express";
import helmet from "helmet";
import { checkDatabaseConnection } from "./db.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));

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

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "not_found",
  });
});

export default app;
