import express from "express";
import {
  getAdminDashboard,
  listAdminDevices,
  listAdminLicenses,
  listAdminSales,
  reconcileAdminSales,
} from "./admin-dashboard-service.js";
import {
  SecurityConfigurationError,
  verifyAdminSecret,
} from "./security.js";

const router = express.Router();

function adminSecret(req) {
  const direct = req.get("x-admin-secret");
  if (direct && direct.trim()) return direct.trim();

  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

function requireAdmin(req, res, next) {
  try {
    if (!verifyAdminSecret(adminSecret(req))) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

function parseLimit(value, fallback, max) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > max) {
    return null;
  }
  return numeric;
}

function parseDateRange(req) {
  const fromRaw = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const toRaw = typeof req.query.to === "string" ? req.query.to.trim() : "";

  if (!fromRaw || !toRaw) {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { from: from.toISOString(), to: to.toISOString() };
  }

  const from = new Date(fromRaw);
  const to = new Date(toRaw);
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    to <= from
  ) {
    return null;
  }

  const maxRangeMs = 1000 * 60 * 60 * 24 * 366 * 5;
  if (to.getTime() - from.getTime() > maxRangeMs) {
    return null;
  }

  return { from: from.toISOString(), to: to.toISOString() };
}

function sendError(res, error) {
  if (error instanceof SecurityConfigurationError) {
    console.error("[Admin Dashboard API] required server secret is not configured", {
      variable: error.variableName,
    });
    return res.status(503).json({ ok: false, error: "server_not_configured" });
  }

  console.error("[Admin Dashboard API] unexpected error", error);
  return res.status(500).json({ ok: false, error: "internal_error" });
}

router.get("/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const range = parseDateRange(req);
    if (!range) {
      return res.status(400).json({ ok: false, error: "invalid_date_range" });
    }

    const dashboard = await getAdminDashboard(range);
    return res.status(200).json({ ok: true, dashboard });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/sales", requireAdmin, async (req, res) => {
  try {
    const range = parseDateRange(req);
    const limit = parseLimit(req.query.limit, 250, 1000);
    if (!range || limit === null) {
      return res.status(400).json({ ok: false, error: "invalid_request" });
    }

    const sales = await listAdminSales({ ...range, limit });
    return res.status(200).json({ ok: true, sales });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/admin/sales/reconcile", requireAdmin, async (req, res) => {
  try {
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    const limit = parseLimit(body.limit, 25, 50);
    if (limit === null) {
      return res.status(400).json({ ok: false, error: "invalid_request" });
    }

    const reconciliation = await reconcileAdminSales({ limit });
    return res.status(200).json({ ok: true, reconciliation });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/licenses", requireAdmin, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 500, 1000);
    if (limit === null) {
      return res.status(400).json({ ok: false, error: "invalid_request" });
    }

    const licenses = await listAdminLicenses({ limit });
    return res.status(200).json({ ok: true, licenses });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/devices", requireAdmin, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 1000, 2000);
    if (limit === null) {
      return res.status(400).json({ ok: false, error: "invalid_request" });
    }

    const devices = await listAdminDevices({ limit });
    return res.status(200).json({ ok: true, devices });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
