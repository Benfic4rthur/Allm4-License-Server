import express from "express";
import helmet from "helmet";

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

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "not_found",
  });
});

export default app;
