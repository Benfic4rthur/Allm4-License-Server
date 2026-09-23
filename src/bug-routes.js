import express from "express";
import {
  claimBugReport,
  createBugReport,
  dispatchBugToCodex,
  getBugReportForClient,
  getBugRepairSettings,
  getMaintainerBugReport,
  listMaintainerQueue,
  listMaintainerReports,
  markBugAutomationUnavailable,
  updateBugRepairSettings,
  updateBugReport,
} from "./bug-service.js";
import {
  SecurityConfigurationError,
  verifyBugMaintainerSecret,
} from "./security.js";

const router = express.Router();

function getObjectBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return {};
  return req.body;
}

function maintainerSecret(req) {
  const direct = req.get("x-bug-maintainer-secret");
  if (direct && direct.trim()) return direct.trim();
  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return "";
}

function requireMaintainer(req, res, next) {
  try {
    if (!verifyBugMaintainerSecret(maintainerSecret(req))) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

function parsePublicNumber(value) {
  const text = String(value || "").trim().toUpperCase();
  const match = text.match(/^(?:BUG-)?0*(\d{1,12})$/);
  if (!match) return null;
  const numeric = Number(match[1]);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function sendError(res, error) {
  if (error instanceof SecurityConfigurationError) {
    console.error("[Bug API] required server secret is not configured", {
      variable: error.variableName,
    });
    return res.status(503).json({ ok: false, error: "server_not_configured" });
  }

  if (error?.code === "invalid_request") {
    return res.status(400).json({ ok: false, error: "invalid_request" });
  }

  if (
    [
      "bug_claim_conflict",
      "bug_claim_window_open",
      "bug_automation_deferred",
      "bug_automation_disabled",
    ].includes(error?.code)
  ) {
    return res.status(409).json({ ok: false, error: error.code });
  }

  console.error("[Bug API] unexpected error", error);
  return res.status(500).json({ ok: false, error: "internal_error" });
}

router.post("/bugs", async (req, res) => {
  try {
    const body = getObjectBody(req);
    const created = await createBugReport({
      title: body.title,
      description: body.description,
      module: body.module,
      appVersion: body.app_version,
      platform: body.platform,
      arch: body.arch,
      errorMessage: body.error_message,
      errorContext: body.error_context,
      diagnostics: body.diagnostics,
      automatic: body.automatic === true,
    });

    return res.status(201).json({
      ok: true,
      bug: created.report,
      tracking_token: created.tracking_token,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/bugs/:bugId", async (req, res) => {
  try {
    const number = parsePublicNumber(req.params.bugId);
    const token = typeof req.query.tracking_token === "string" ? req.query.tracking_token.trim() : "";
    if (!number || !token) {
      return res.status(404).json({ ok: false, error: "bug_not_found" });
    }

    const report = await getBugReportForClient(number, token);
    if (!report) return res.status(404).json({ ok: false, error: "bug_not_found" });
    return res.status(200).json({ ok: true, bug: report });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/bugs", requireMaintainer, async (req, res) => {
  try {
    const reports = await listMaintainerReports(req.query.limit);
    return res.status(200).json({ ok: true, bugs: reports });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/bugs/settings", requireMaintainer, async (_req, res) => {
  try {
    const settings = await getBugRepairSettings();
    return res.status(200).json({ ok: true, settings });
  } catch (error) {
    return sendError(res, error);
  }
});

router.patch("/admin/bugs/settings", requireMaintainer, async (req, res) => {
  try {
    const body = getObjectBody(req);
    const settings = await updateBugRepairSettings({
      manualClaimMinutes: body.manual_claim_minutes,
      codexRetryMinutes: body.codex_retry_minutes,
      autoAssignCodex: body.auto_assign_codex,
    });
    return res.status(200).json({ ok: true, settings });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/bugs/queue", requireMaintainer, async (req, res) => {
  try {
    const reports = await listMaintainerQueue(req.query.limit);
    return res.status(200).json({ ok: true, bugs: reports });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/bugs/:bugId", requireMaintainer, async (req, res) => {
  try {
    const number = parsePublicNumber(req.params.bugId);
    if (!number) return res.status(404).json({ ok: false, error: "bug_not_found" });
    const report = await getMaintainerBugReport(number);
    if (!report) return res.status(404).json({ ok: false, error: "bug_not_found" });
    return res.status(200).json({ ok: true, bug: report });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/admin/bugs/:bugId/dispatch-codex", requireMaintainer, async (req, res) => {
  try {
    const number = parsePublicNumber(req.params.bugId);
    if (!number) return res.status(404).json({ ok: false, error: "bug_not_found" });
    const body = getObjectBody(req);
    const report = await dispatchBugToCodex(number, body.note);
    if (!report) return res.status(404).json({ ok: false, error: "bug_not_found" });
    return res.status(200).json({ ok: true, bug: report });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/admin/bugs/:bugId/claim", requireMaintainer, async (req, res) => {
  try {
    const number = parsePublicNumber(req.params.bugId);
    if (!number) return res.status(404).json({ ok: false, error: "bug_not_found" });
    const body = getObjectBody(req);
    const report = await claimBugReport(number, body.note, body.assignee);
    if (!report) return res.status(404).json({ ok: false, error: "bug_not_found" });
    return res.status(200).json({ ok: true, bug: report });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/admin/bugs/:bugId/automation-unavailable", requireMaintainer, async (req, res) => {
  try {
    const number = parsePublicNumber(req.params.bugId);
    if (!number) return res.status(404).json({ ok: false, error: "bug_not_found" });
    const body = getObjectBody(req);
    const report = await markBugAutomationUnavailable(
      number,
      body.reason,
      body.note,
    );
    if (!report) return res.status(404).json({ ok: false, error: "bug_not_found" });
    return res.status(200).json({ ok: true, bug: report });
  } catch (error) {
    return sendError(res, error);
  }
});

router.patch("/admin/bugs/:bugId", requireMaintainer, async (req, res) => {
  try {
    const number = parsePublicNumber(req.params.bugId);
    if (!number) return res.status(404).json({ ok: false, error: "bug_not_found" });
    const body = getObjectBody(req);
    const report = await updateBugReport(number, {
      status: body.status,
      note: body.note,
      githubIssueNumber: body.github_issue_number,
      githubIssueUrl: body.github_issue_url,
      githubBranch: body.github_branch,
      pullRequestUrl: body.pull_request_url,
      releaseVersion: body.release_version,
      maintainerNote: body.maintainer_note,
    });
    if (!report) return res.status(404).json({ ok: false, error: "bug_not_found" });
    return res.status(200).json({ ok: true, bug: report });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
