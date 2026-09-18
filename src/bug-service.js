import { createHash } from "node:crypto";
import { getPool, withTransaction } from "./db.js";
import {
  generateBugTrackingToken,
  hashBugTrackingToken,
} from "./security.js";

const PUBLIC_STATUSES = new Set([
  "reported",
  "received",
  "working",
  "changes_ready",
  "awaiting_approval",
  "merging",
  "releasing",
  "update_available",
  "resolved",
  "blocked",
]);

const MAX_DIAGNOSTICS_CHARS = 90000;

function normalizeText(value, maxLength, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

function redactText(value) {
  return String(value || "")
    .replace(/("(?:authorization|password|access[_-]?token|refresh[_-]?token|github[_-]?token|private[_-]?token|client[_-]?token|license[_-]?key)"\s*:\s*")[^"]*/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s"'\]}]+/gi, "$1[REDACTED]")
    .replace(/((?:access|refresh|github|private|client|license)[_-]?(?:token|key)\s*[:=]\s*)[^\s"'\]}]+/gi, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*)[^\s"'\]}]+/gi, "$1[REDACTED]")
    .replace(/(https:\/\/)([^/@\s:]+):([^/@\s]+)@/gi, "$1[REDACTED]@");
}

function sanitizeDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return {};
  }
  text = redactText(text).slice(0, MAX_DIAGNOSTICS_CHARS);
  try {
    return JSON.parse(text);
  } catch {
    return {
      truncated_text: text,
    };
  }
}

function signatureFor(input) {
  const normalized = [
    normalizeText(input.errorMessage, 4000),
    normalizeText(input.errorContext, 1000),
    normalizeText(input.module, 200),
    normalizeText(input.appVersion, 80),
  ]
    .join("\n")
    .toLowerCase()
    .replace(/\b0x[0-9a-f]+\b/gi, "0x?")
    .replace(/\b\d{4,}\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function publicId(number) {
  return `BUG-${String(number).padStart(6, "0")}`;
}

function toPublicReport(row, events = []) {
  return {
    id: publicId(row.number),
    status: row.status,
    title: row.title,
    module: row.module,
    app_version: row.app_version,
    duplicate_count: Number(row.duplicate_count || 1),
    github_issue_url: row.github_issue_url || null,
    pull_request_url: row.pull_request_url || null,
    release_version: row.release_version || null,
    maintainer_note: row.maintainer_note || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at || null,
    timeline: events.map((event) => ({
      status: event.status,
      note: event.note || null,
      created_at: event.created_at,
    })),
  };
}

function toMaintainerReport(row) {
  return {
    id: publicId(row.number),
    number: Number(row.number),
    status: row.status,
    title: row.title,
    description: row.description || "",
    module: row.module || "",
    app_version: row.app_version,
    platform: row.platform || "",
    arch: row.arch || "",
    error_message: row.error_message || "",
    error_context: row.error_context || "",
    diagnostics: row.diagnostics || {},
    signature_hash: row.signature_hash || null,
    duplicate_count: Number(row.duplicate_count || 1),
    github_issue_number: row.github_issue_number || null,
    github_issue_url: row.github_issue_url || null,
    github_branch: row.github_branch || null,
    pull_request_url: row.pull_request_url || null,
    release_version: row.release_version || null,
    maintainer_note: row.maintainer_note || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createBugReport(input) {
  const title = normalizeText(input.title, 180, "Erro reportado pelo Allm4");
  const appVersion = normalizeText(input.appVersion, 80);
  if (!appVersion) {
    const error = new Error("app_version is required");
    error.code = "invalid_request";
    throw error;
  }

  const trackingToken = generateBugTrackingToken();
  const trackingTokenHash = hashBugTrackingToken(trackingToken);
  const diagnostics = sanitizeDiagnostics(input.diagnostics);
  const errorMessage = redactText(normalizeText(input.errorMessage, 8000));
  const errorContext = redactText(normalizeText(input.errorContext, 2000));
  const description = redactText(normalizeText(input.description, 8000));
  const signatureHash = signatureFor({
    errorMessage,
    errorContext,
    module: input.module,
    appVersion,
  });

  const result = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO bug_reports (
        tracking_token_hash,
        status,
        title,
        description,
        module,
        app_version,
        platform,
        arch,
        error_message,
        error_context,
        signature_hash,
        diagnostics
      ) VALUES ($1, 'reported', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      RETURNING *`,
      [
        trackingTokenHash,
        title,
        description || null,
        normalizeText(input.module, 200) || null,
        appVersion,
        normalizeText(input.platform, 120) || null,
        normalizeText(input.arch, 120) || null,
        errorMessage || null,
        errorContext || null,
        signatureHash,
        JSON.stringify(diagnostics),
      ],
    );
    const row = inserted.rows[0];
    await client.query(
      "INSERT INTO bug_report_events (bug_report_id, status, note) VALUES ($1, 'reported', $2)",
      [row.id, "Relatório enviado pelo aplicativo."],
    );
    return row;
  });

  return {
    report: toPublicReport(result, [{
      status: "reported",
      note: "Relatório enviado pelo aplicativo.",
      created_at: result.created_at,
    }]),
    tracking_token: trackingToken,
  };
}

export async function getBugReportForClient(number, trackingToken) {
  const numeric = Number(number);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  let tokenHash;
  try {
    tokenHash = hashBugTrackingToken(trackingToken);
  } catch {
    return null;
  }

  const pool = getPool();
  const result = await pool.query(
    "SELECT * FROM bug_reports WHERE number = $1 AND tracking_token_hash = $2 LIMIT 1",
    [numeric, tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;

  const events = await pool.query(
    "SELECT status, note, created_at FROM bug_report_events WHERE bug_report_id = $1 ORDER BY created_at ASC, id ASC",
    [row.id],
  );
  return toPublicReport(row, events.rows);
}

export async function listMaintainerQueue(limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM bug_reports
     WHERE status IN ('reported', 'received', 'working', 'changes_ready', 'awaiting_approval', 'blocked')
     ORDER BY
       CASE status
         WHEN 'working' THEN 0
         WHEN 'changes_ready' THEN 1
         WHEN 'awaiting_approval' THEN 2
         WHEN 'received' THEN 3
         WHEN 'reported' THEN 4
         ELSE 5
       END,
       created_at ASC
     LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map(toMaintainerReport);
}

export async function claimBugReport(number, note = "") {
  const numeric = Number(number);
  if (!Number.isInteger(numeric) || numeric < 1) return null;

  return withTransaction(async (client) => {
    const result = await client.query(
      "SELECT * FROM bug_reports WHERE number = $1 FOR UPDATE",
      [numeric],
    );
    const row = result.rows[0];
    if (!row) return null;

    let nextStatus = row.status;
    if (row.status === "reported" || row.status === "received" || row.status === "blocked") {
      if (row.status === "reported") {
        await client.query(
          "INSERT INTO bug_report_events (bug_report_id, status, note) VALUES ($1, 'received', $2)",
          [row.id, "Relatório recebido pela fila de manutenção."],
        );
      }
      nextStatus = "working";
      const updated = await client.query(
        `UPDATE bug_reports
         SET status = 'working',
             claimed_at = COALESCE(claimed_at, NOW()),
             maintainer_note = COALESCE(NULLIF($2, ''), maintainer_note),
             updated_at = NOW()
         WHERE number = $1
         RETURNING *`,
        [numeric, normalizeText(note, 1000)],
      );
      row.status = updated.rows[0].status;
      row.claimed_at = updated.rows[0].claimed_at;
      row.maintainer_note = updated.rows[0].maintainer_note;
      row.updated_at = updated.rows[0].updated_at;
      await client.query(
        "INSERT INTO bug_report_events (bug_report_id, status, note) VALUES ($1, 'working', $2)",
        [row.id, normalizeText(note, 1000, "Atendimento iniciado pelo mantenedor.")],
      );
    }

    return toMaintainerReport({ ...row, status: nextStatus });
  });
}

export async function updateBugReport(number, patch = {}) {
  const numeric = Number(number);
  if (!Number.isInteger(numeric) || numeric < 1) return null;

  const status = patch.status === undefined ? null : normalizeText(patch.status, 80);
  if (status && !PUBLIC_STATUSES.has(status)) {
    const error = new Error("invalid bug status");
    error.code = "invalid_request";
    throw error;
  }

  return withTransaction(async (client) => {
    const current = await client.query(
      "SELECT * FROM bug_reports WHERE number = $1 FOR UPDATE",
      [numeric],
    );
    if (!current.rows[0]) return null;
    const previous = current.rows[0];

    const values = {
      status: status || previous.status,
      githubIssueNumber: Number.isInteger(Number(patch.githubIssueNumber)) ? Number(patch.githubIssueNumber) : previous.github_issue_number,
      githubIssueUrl: patch.githubIssueUrl === undefined ? previous.github_issue_url : normalizeText(patch.githubIssueUrl, 1000) || null,
      githubBranch: patch.githubBranch === undefined ? previous.github_branch : normalizeText(patch.githubBranch, 300) || null,
      pullRequestUrl: patch.pullRequestUrl === undefined ? previous.pull_request_url : normalizeText(patch.pullRequestUrl, 1000) || null,
      releaseVersion: patch.releaseVersion === undefined ? previous.release_version : normalizeText(patch.releaseVersion, 120) || null,
      maintainerNote: patch.maintainerNote === undefined ? previous.maintainer_note : redactText(normalizeText(patch.maintainerNote, 4000)) || null,
    };

    const resolvedAt = values.status === "resolved"
      ? "COALESCE(resolved_at, NOW())"
      : "resolved_at";

    const updated = await client.query(
      `UPDATE bug_reports
       SET status = $2,
           github_issue_number = $3,
           github_issue_url = $4,
           github_branch = $5,
           pull_request_url = $6,
           release_version = $7,
           maintainer_note = $8,
           resolved_at = ${resolvedAt},
           updated_at = NOW()
       WHERE number = $1
       RETURNING *`,
      [
        numeric,
        values.status,
        values.githubIssueNumber,
        values.githubIssueUrl,
        values.githubBranch,
        values.pullRequestUrl,
        values.releaseVersion,
        values.maintainerNote,
      ],
    );

    const row = updated.rows[0];
    if (values.status !== previous.status || patch.note) {
      await client.query(
        "INSERT INTO bug_report_events (bug_report_id, status, note, metadata) VALUES ($1, $2, $3, $4::jsonb)",
        [
          row.id,
          values.status,
          redactText(normalizeText(patch.note, 2000)) || null,
          JSON.stringify({
            github_issue_url: values.githubIssueUrl,
            pull_request_url: values.pullRequestUrl,
            release_version: values.releaseVersion,
          }),
        ],
      );
    }

    return toMaintainerReport(row);
  });
}
