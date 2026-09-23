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

const BUG_ASSIGNEES = new Set(["unassigned", "manual", "codex"]);
const AUTOMATION_STATES = new Set([
  "waiting_manual",
  "ready",
  "running",
  "unavailable",
  "manual",
  "complete",
]);
const MAX_DIAGNOSTICS_CHARS = 90000;
const DEFAULT_MANUAL_CLAIM_MINUTES = 30;
const DEFAULT_CODEX_RETRY_MINUTES = 30;
let schemaReady = null;

async function ensureBugSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS bug_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        number BIGSERIAL UNIQUE NOT NULL,
        tracking_token_hash TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN (
          'reported','received','working','changes_ready','awaiting_approval',
          'merging','releasing','update_available','resolved','blocked'
        )),
        title TEXT NOT NULL,
        description TEXT,
        module TEXT,
        app_version TEXT NOT NULL,
        platform TEXT,
        arch TEXT,
        error_message TEXT,
        error_context TEXT,
        signature_hash TEXT,
        diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
        duplicate_count INTEGER NOT NULL DEFAULT 1 CHECK (duplicate_count > 0),
        github_issue_number INTEGER,
        github_issue_url TEXT,
        github_branch TEXT,
        pull_request_url TEXT,
        release_version TEXT,
        maintainer_note TEXT,
        claimed_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bug_report_events (
        id BIGSERIAL PRIMARY KEY,
        bug_report_id UUID NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        note TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
      CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON bug_reports(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bug_reports_signature ON bug_reports(signature_hash) WHERE signature_hash IS NOT NULL;
      CREATE TABLE IF NOT EXISTS bug_report_watchers (
        id BIGSERIAL PRIMARY KEY,
        bug_report_id UUID NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
        tracking_token_hash TEXT UNIQUE NOT NULL,
        app_version TEXT,
        platform TEXT,
        arch TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bug_report_occurrences (
        id BIGSERIAL PRIMARY KEY,
        bug_report_id UUID NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
        app_version TEXT,
        platform TEXT,
        arch TEXT,
        description TEXT,
        error_message TEXT,
        error_context TEXT,
        diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_bug_report_events_bug ON bug_report_events(bug_report_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_bug_report_watchers_bug ON bug_report_watchers(bug_report_id);
      CREATE INDEX IF NOT EXISTS idx_bug_report_occurrences_bug ON bug_report_occurrences(bug_report_id, created_at DESC);

      ALTER TABLE bug_reports
        ADD COLUMN IF NOT EXISTS assigned_to TEXT NOT NULL DEFAULT 'unassigned'
          CHECK (assigned_to IN ('unassigned','manual','codex')),
        ADD COLUMN IF NOT EXISTS manual_claim_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS automation_state TEXT NOT NULL DEFAULT 'waiting_manual'
          CHECK (automation_state IN ('waiting_manual','ready','running','unavailable','manual','complete')),
        ADD COLUMN IF NOT EXISTS automation_last_error TEXT,
        ADD COLUMN IF NOT EXISTS automation_retry_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_bug_reports_assignment
        ON bug_reports(assigned_to, automation_state, manual_claim_until, automation_retry_at);

      CREATE TABLE IF NOT EXISTS bug_repair_settings (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        manual_claim_minutes INTEGER NOT NULL DEFAULT 30
          CHECK (manual_claim_minutes >= 0 AND manual_claim_minutes <= 1440),
        codex_retry_minutes INTEGER NOT NULL DEFAULT 30
          CHECK (codex_retry_minutes >= 5 AND codex_retry_minutes <= 1440),
        auto_assign_codex BOOLEAN NOT NULL DEFAULT TRUE,
        triage_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (triage_mode IN ('manual','timed')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE bug_repair_settings
        ADD COLUMN IF NOT EXISTS triage_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (triage_mode IN ('manual','timed'));

      INSERT INTO bug_repair_settings (
        id, manual_claim_minutes, codex_retry_minutes, auto_assign_codex, triage_mode
      ) VALUES (1, 30, 30, FALSE, 'manual')
      ON CONFLICT (id) DO NOTHING;

      UPDATE bug_reports
      SET assigned_to = 'codex',
          automation_state = 'running'
      WHERE assigned_to = 'unassigned'
        AND automation_state = 'waiting_manual'
        AND status IN (
          'working','changes_ready','awaiting_approval','merging','releasing','blocked'
        );

      UPDATE bug_reports
      SET automation_state = 'waiting_manual',
          automation_retry_at = NULL
      WHERE assigned_to = 'unassigned'
        AND automation_state = 'ready'
        AND EXISTS (
          SELECT 1
          FROM bug_repair_settings
          WHERE id = 1
            AND triage_mode = 'manual'
        );

      UPDATE bug_reports
      SET manual_claim_until = COALESCE(
        manual_claim_until,
        created_at + (
          SELECT make_interval(mins => manual_claim_minutes)
          FROM bug_repair_settings
          WHERE id = 1
        )
      )
      WHERE manual_claim_until IS NULL
        AND status NOT IN ('resolved', 'update_available');

      UPDATE bug_reports
      SET automation_state = 'complete'
      WHERE status IN ('resolved', 'update_available')
        AND automation_state <> 'complete';
    `).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function repairSettingsForClient(client) {
  const result = await client.query(
    `SELECT manual_claim_minutes, codex_retry_minutes, auto_assign_codex, triage_mode, updated_at
     FROM bug_repair_settings
     WHERE id = 1
     LIMIT 1`,
  );
  const row = result.rows[0] || {};
  return {
    manual_claim_minutes: Number.isInteger(Number(row.manual_claim_minutes))
      ? Number(row.manual_claim_minutes)
      : DEFAULT_MANUAL_CLAIM_MINUTES,
    codex_retry_minutes: Number.isInteger(Number(row.codex_retry_minutes))
      ? Number(row.codex_retry_minutes)
      : DEFAULT_CODEX_RETRY_MINUTES,
    triage_mode: row.triage_mode === "timed" ? "timed" : "manual",
    auto_assign_codex:
      row.triage_mode === "timed" && row.auto_assign_codex !== false,
    updated_at: row.updated_at || null,
  };
}

async function refreshAutomationReadiness(client) {
  const settings = await repairSettingsForClient(client);
  if (settings.triage_mode !== "timed" || !settings.auto_assign_codex) return settings;
  await client.query(
    `UPDATE bug_reports
     SET automation_state = 'ready',
         updated_at = NOW()
     WHERE assigned_to = 'unassigned'
       AND automation_state = 'waiting_manual'
       AND status IN ('reported', 'received', 'blocked')
       AND manual_claim_until IS NOT NULL
       AND manual_claim_until <= NOW()`,
  );
  return settings;
}

function normalizeAssignee(value, fallback = "unassigned") {
  const normalized = normalizeText(value, 32, fallback);
  return BUG_ASSIGNEES.has(normalized) ? normalized : fallback;
}

function normalizeAutomationState(value, fallback = "waiting_manual") {
  const normalized = normalizeText(value, 40, fallback);
  return AUTOMATION_STATES.has(normalized) ? normalized : fallback;
}

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
    release_version: row.release_version || null,
    maintainer_note: row.status === "blocked" ? row.maintainer_note || null : null,
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
    assigned_to: normalizeAssignee(row.assigned_to),
    manual_claim_until: row.manual_claim_until || null,
    automation_state: normalizeAutomationState(row.automation_state),
    automation_last_error: row.automation_last_error || null,
    automation_retry_at: row.automation_retry_at || null,
    claimed_at: row.claimed_at || null,
    resolved_at: row.resolved_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toMaintainerSummary(row) {
  return {
    id: publicId(row.number),
    number: Number(row.number),
    status: row.status,
    title: row.title,
    module: row.module || "",
    app_version: row.app_version,
    platform: row.platform || "",
    arch: row.arch || "",
    error_message: row.error_message || "",
    duplicate_count: Number(row.duplicate_count || 1),
    github_issue_number: row.github_issue_number || null,
    github_issue_url: row.github_issue_url || null,
    github_branch: row.github_branch || null,
    pull_request_url: row.pull_request_url || null,
    release_version: row.release_version || null,
    assigned_to: normalizeAssignee(row.assigned_to),
    manual_claim_until: row.manual_claim_until || null,
    automation_state: normalizeAutomationState(row.automation_state),
    automation_last_error: row.automation_last_error || null,
    automation_retry_at: row.automation_retry_at || null,
    claimed_at: row.claimed_at || null,
    resolved_at: row.resolved_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getBugRepairSettings() {
  await ensureBugSchema();
  return repairSettingsForClient(getPool());
}

export async function updateBugRepairSettings(patch = {}) {
  await ensureBugSchema();
  const pool = getPool();
  const current = await repairSettingsForClient(pool);

  const manualClaimMinutes =
    patch.manualClaimMinutes === undefined
      ? current.manual_claim_minutes
      : Number(patch.manualClaimMinutes);
  const codexRetryMinutes =
    patch.codexRetryMinutes === undefined
      ? current.codex_retry_minutes
      : Number(patch.codexRetryMinutes);
  const autoAssignCodex =
    patch.autoAssignCodex === undefined
      ? current.auto_assign_codex
      : patch.autoAssignCodex === true;
  const triageMode = autoAssignCodex ? "timed" : "manual";

  if (
    !Number.isInteger(manualClaimMinutes) ||
    manualClaimMinutes < 0 ||
    manualClaimMinutes > 1440 ||
    !Number.isInteger(codexRetryMinutes) ||
    codexRetryMinutes < 5 ||
    codexRetryMinutes > 1440
  ) {
    const error = new Error("invalid bug repair settings");
    error.code = "invalid_request";
    throw error;
  }

  const result = await pool.query(
    `UPDATE bug_repair_settings
     SET manual_claim_minutes = $1,
         codex_retry_minutes = $2,
         auto_assign_codex = $3,
         triage_mode = $4,
         updated_at = NOW()
     WHERE id = 1
     RETURNING manual_claim_minutes, codex_retry_minutes, auto_assign_codex, triage_mode, updated_at`,
    [manualClaimMinutes, codexRetryMinutes, autoAssignCodex, triageMode],
  );

  return {
    manual_claim_minutes: Number(result.rows[0].manual_claim_minutes),
    codex_retry_minutes: Number(result.rows[0].codex_retry_minutes),
    triage_mode: result.rows[0].triage_mode === "timed" ? "timed" : "manual",
    auto_assign_codex:
      result.rows[0].triage_mode === "timed" &&
      result.rows[0].auto_assign_codex === true,
    updated_at: result.rows[0].updated_at,
  };
}

export async function createBugReport(input) {
  await ensureBugSchema();
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
  const moduleName = normalizeText(input.module, 200);
  const platform = normalizeText(input.platform, 120);
  const arch = normalizeText(input.arch, 120);
  const signatureHash = signatureFor({
    errorMessage,
    errorContext,
    module: moduleName,
  });

  const result = await withTransaction(async (client) => {
    const repairSettings = await repairSettingsForClient(client);
    let existing = null;
    if (signatureHash) {
      const matched = await client.query(
        `SELECT * FROM bug_reports
         WHERE signature_hash = $1
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [signatureHash],
      );
      existing = matched.rows[0] || null;
    }

    if (existing) {
      const previousStatus = existing.status;
      const reopened = previousStatus === "resolved" || previousStatus === "update_available";
      const updated = await client.query(
        `UPDATE bug_reports
         SET duplicate_count = duplicate_count + 1,
             status = CASE WHEN $2 THEN 'reported' ELSE status END,
             resolved_at = CASE WHEN $2 THEN NULL ELSE resolved_at END,
             claimed_at = CASE WHEN $2 THEN NULL ELSE claimed_at END,
             pull_request_url = CASE WHEN $2 THEN NULL ELSE pull_request_url END,
             release_version = CASE WHEN $2 THEN NULL ELSE release_version END,
             maintainer_note = CASE WHEN $2 THEN NULL ELSE maintainer_note END,
             assigned_to = CASE WHEN $2 THEN 'unassigned' ELSE assigned_to END,
             manual_claim_until = CASE
               WHEN $2 THEN NOW() + make_interval(mins => $10::int)
               ELSE manual_claim_until
             END,
             automation_state = CASE WHEN $2 THEN 'waiting_manual' ELSE automation_state END,
             automation_last_error = CASE WHEN $2 THEN NULL ELSE automation_last_error END,
             automation_retry_at = CASE WHEN $2 THEN NULL ELSE automation_retry_at END,
             app_version = $3,
             platform = COALESCE(NULLIF($4, ''), platform),
             arch = COALESCE(NULLIF($5, ''), arch),
             error_message = COALESCE(NULLIF($6, ''), error_message),
             error_context = COALESCE(NULLIF($7, ''), error_context),
             diagnostics = $8::jsonb,
             description = COALESCE(NULLIF($9, ''), description),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          existing.id,
          reopened,
          appVersion,
          platform,
          arch,
          errorMessage,
          errorContext,
          JSON.stringify(diagnostics),
          description,
          repairSettings.manual_claim_minutes,
        ],
      );
      const row = updated.rows[0];

      await client.query(
        `INSERT INTO bug_report_watchers (
          bug_report_id, tracking_token_hash, app_version, platform, arch
        ) VALUES ($1, $2, $3, $4, $5)`,
        [row.id, trackingTokenHash, appVersion, platform || null, arch || null],
      );
      await client.query(
        `INSERT INTO bug_report_occurrences (
          bug_report_id, app_version, platform, arch, description,
          error_message, error_context, diagnostics
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          row.id,
          appVersion,
          platform || null,
          arch || null,
          description || null,
          errorMessage || null,
          errorContext || null,
          JSON.stringify(diagnostics),
        ],
      );
      await client.query(
        "INSERT INTO bug_report_events (bug_report_id, status, note, metadata) VALUES ($1, $2, $3, $4::jsonb)",
        [
          row.id,
          row.status,
          reopened
            ? "O mesmo problema voltou a ocorrer após uma correção anterior. O Alma Repair reabriu o atendimento."
            : "Outra instalação encontrou o mesmo problema. A ocorrência foi agrupada automaticamente.",
          JSON.stringify({
            occurrence_app_version: appVersion,
            previous_status: previousStatus,
            deduplicated: true,
            reopened,
          }),
        ],
      );

      return { row, deduplicated: true, reopened };
    }

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
        diagnostics,
        assigned_to,
        manual_claim_until,
        automation_state
      ) VALUES (
        $1, 'reported', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
        'unassigned',
        NOW() + make_interval(mins => $12::int),
        'waiting_manual'
      )
      RETURNING *`,
      [
        trackingTokenHash,
        title,
        description || null,
        moduleName || null,
        appVersion,
        platform || null,
        arch || null,
        errorMessage || null,
        errorContext || null,
        signatureHash,
        JSON.stringify(diagnostics),
        repairSettings.manual_claim_minutes,
      ],
    );
    const row = inserted.rows[0];
    await client.query(
      `INSERT INTO bug_report_watchers (
        bug_report_id, tracking_token_hash, app_version, platform, arch
      ) VALUES ($1, $2, $3, $4, $5)`,
      [row.id, trackingTokenHash, appVersion, platform || null, arch || null],
    );
    await client.query(
      `INSERT INTO bug_report_occurrences (
        bug_report_id, app_version, platform, arch, description,
        error_message, error_context, diagnostics
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        row.id,
        appVersion,
        platform || null,
        arch || null,
        description || null,
        errorMessage || null,
        errorContext || null,
        JSON.stringify(diagnostics),
      ],
    );
    await client.query(
      "INSERT INTO bug_report_events (bug_report_id, status, note) VALUES ($1, 'reported', $2)",
      [row.id, input.automatic === true
        ? "Falha detectada e enviada automaticamente pelo Alma Repair."
        : "Relatório enviado manualmente pelo aplicativo."],
    );
    return { row, deduplicated: false, reopened: false };
  });

  const events = await getPool().query(
    "SELECT status, note, created_at FROM bug_report_events WHERE bug_report_id = $1 ORDER BY created_at ASC, id ASC",
    [result.row.id],
  );

  return {
    report: toPublicReport(result.row, events.rows),
    tracking_token: trackingToken,
    deduplicated: result.deduplicated,
    reopened: result.reopened,
  };
}

export async function getBugReportForClient(number, trackingToken) {
  await ensureBugSchema();
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
    `SELECT br.*
     FROM bug_reports br
     WHERE br.number = $1
       AND (
         br.tracking_token_hash = $2
         OR EXISTS (
           SELECT 1
           FROM bug_report_watchers watcher
           WHERE watcher.bug_report_id = br.id
             AND watcher.tracking_token_hash = $2
         )
       )
     LIMIT 1`,
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

export async function listMaintainerReports(limit = 200) {
  await ensureBugSchema();
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const pool = getPool();
  await refreshAutomationReadiness(pool);
  const result = await pool.query(
    `SELECT * FROM bug_reports
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map(toMaintainerSummary);
}

export async function getMaintainerBugReport(number) {
  await ensureBugSchema();
  const numeric = Number(number);
  if (!Number.isInteger(numeric) || numeric < 1) return null;

  const pool = getPool();
  await refreshAutomationReadiness(pool);
  const result = await pool.query(
    "SELECT * FROM bug_reports WHERE number = $1 LIMIT 1",
    [numeric],
  );
  const row = result.rows[0];
  if (!row) return null;

  const [events, occurrences] = await Promise.all([
    pool.query(
      "SELECT status, note, metadata, created_at FROM bug_report_events WHERE bug_report_id = $1 ORDER BY created_at ASC, id ASC",
      [row.id],
    ),
    pool.query(
      `SELECT app_version, platform, arch, description, error_message, error_context, diagnostics, created_at
       FROM bug_report_occurrences
       WHERE bug_report_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      [row.id],
    ),
  ]);

  return {
    ...toMaintainerReport(row),
    timeline: events.rows.map((event) => ({
      status: event.status,
      note: event.note || null,
      metadata: event.metadata || {},
      created_at: event.created_at,
    })),
    occurrences: occurrences.rows.map((occurrence) => ({
      app_version: occurrence.app_version || "",
      platform: occurrence.platform || "",
      arch: occurrence.arch || "",
      description: occurrence.description || "",
      error_message: occurrence.error_message || "",
      error_context: occurrence.error_context || "",
      diagnostics: occurrence.diagnostics || {},
      created_at: occurrence.created_at,
    })),
  };
}

export async function listMaintainerQueue(limit = 20) {
  await ensureBugSchema();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const pool = getPool();
  const settings = await refreshAutomationReadiness(pool);
  const result = await pool.query(
    `SELECT * FROM bug_reports
     WHERE (
       assigned_to = 'codex'
       AND status IN ('received', 'working', 'changes_ready', 'awaiting_approval', 'blocked')
     ) OR (
       $2::boolean = TRUE
       AND assigned_to = 'unassigned'
       AND status IN ('reported', 'received', 'blocked')
       AND manual_claim_until IS NOT NULL
       AND manual_claim_until <= NOW()
       AND (automation_retry_at IS NULL OR automation_retry_at <= NOW())
       AND automation_state IN ('ready', 'unavailable')
     )
     ORDER BY
       CASE
         WHEN assigned_to = 'codex' AND status = 'working' THEN 0
         WHEN assigned_to = 'codex' AND status = 'changes_ready' THEN 1
         WHEN assigned_to = 'codex' AND status = 'awaiting_approval' THEN 2
         WHEN assigned_to = 'codex' AND status = 'received' THEN 3
         WHEN assigned_to = 'codex' AND status = 'blocked' THEN 4
         WHEN assigned_to = 'unassigned' AND automation_state = 'ready' THEN 5
         ELSE 6
       END,
       COALESCE(automation_retry_at, manual_claim_until, created_at) ASC,
       created_at ASC
     LIMIT $1`,
    [safeLimit, settings.auto_assign_codex],
  );
  return result.rows.map(toMaintainerReport);
}

function claimConflict(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

export async function dispatchBugToCodex(number, note = "") {
  await ensureBugSchema();
  const numeric = Number(number);
  if (!Number.isInteger(numeric) || numeric < 1) return null;

  return withTransaction(async (client) => {
    const result = await client.query(
      "SELECT * FROM bug_reports WHERE number = $1 FOR UPDATE",
      [numeric],
    );
    const row = result.rows[0];
    if (!row) return null;

    const currentAssignee = normalizeAssignee(row.assigned_to);
    if (["resolved", "update_available"].includes(row.status)) {
      throw claimConflict("bug_claim_conflict", "bug is already resolved");
    }
    if (currentAssignee === "manual") {
      throw claimConflict("bug_claim_conflict", "bug is reserved for manual handling");
    }
    if (currentAssignee === "codex") {
      return toMaintainerReport(row);
    }

    const nextStatus = ["reported", "blocked"].includes(row.status)
      ? "received"
      : row.status;
    const safeNote = normalizeText(
      note,
      1000,
      "Bug delegado manualmente ao Codex pelo Allm4 Admin.",
    );
    const updated = await client.query(
      `UPDATE bug_reports
       SET status = $2,
           assigned_to = 'codex',
           automation_state = 'ready',
           automation_last_error = NULL,
           automation_retry_at = NULL,
           maintainer_note = $3,
           updated_at = NOW()
       WHERE number = $1
       RETURNING *`,
      [numeric, nextStatus, safeNote],
    );
    const next = updated.rows[0];

    await client.query(
      "INSERT INTO bug_report_events (bug_report_id, status, note, metadata) VALUES ($1, $2, $3, $4::jsonb)",
      [
        next.id,
        nextStatus,
        safeNote,
        JSON.stringify({
          assigned_to: "codex",
          automation_state: "ready",
          delegated_by: "admin",
        }),
      ],
    );

    return toMaintainerReport(next);
  });
}

export async function claimBugReport(number, note = "", assignee = "codex") {
  await ensureBugSchema();
  const numeric = Number(number);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  const requestedAssignee = normalizeAssignee(assignee, "");
  if (!requestedAssignee || requestedAssignee === "unassigned") {
    const error = new Error("invalid assignee");
    error.code = "invalid_request";
    throw error;
  }

  return withTransaction(async (client) => {
    const result = await client.query(
      "SELECT * FROM bug_reports WHERE number = $1 FOR UPDATE",
      [numeric],
    );
    const row = result.rows[0];
    if (!row) return null;

    const currentAssignee = normalizeAssignee(row.assigned_to);
    const settings = await repairSettingsForClient(client);
    const now = Date.now();
    const manualUntil = row.manual_claim_until ? new Date(row.manual_claim_until).getTime() : 0;
    const retryAt = row.automation_retry_at ? new Date(row.automation_retry_at).getTime() : 0;

    if (["resolved", "update_available"].includes(row.status)) {
      throw claimConflict("bug_claim_conflict", "bug is already resolved");
    }

    if (requestedAssignee === "codex") {
      if (currentAssignee === "manual") {
        throw claimConflict("bug_claim_conflict", "bug is reserved for manual handling");
      }
      if (currentAssignee === "unassigned") {
        if (settings.triage_mode !== "timed" || !settings.auto_assign_codex) {
          throw claimConflict("bug_automation_disabled", "automatic handling is disabled");
        }
        if (manualUntil && manualUntil > now) {
          throw claimConflict("bug_claim_window_open", "manual claim window is still open");
        }
        if (retryAt && retryAt > now) {
          throw claimConflict("bug_automation_deferred", "automatic retry is deferred");
        }
      }
    }

    if (
      requestedAssignee === "manual" &&
      currentAssignee === "codex" &&
      row.status !== "blocked"
    ) {
      throw claimConflict("bug_claim_conflict", "bug is already being handled by Codex");
    }

    if (
      currentAssignee === requestedAssignee &&
      !["reported", "received", "blocked"].includes(row.status)
    ) {
      return toMaintainerReport(row);
    }

    if (row.status === "reported") {
      await client.query(
        "INSERT INTO bug_report_events (bug_report_id, status, note, metadata) VALUES ($1, 'received', $2, $3::jsonb)",
        [
          row.id,
          "Relatório recebido pela fila de manutenção.",
          JSON.stringify({ assigned_to: requestedAssignee }),
        ],
      );
    }

    const nextStatus = "working";
    const automationState = requestedAssignee === "manual" ? "manual" : "running";
    const updated = await client.query(
      `UPDATE bug_reports
       SET status = 'working',
           assigned_to = $2,
           automation_state = $3,
           automation_last_error = CASE WHEN $2 = 'codex' THEN NULL ELSE automation_last_error END,
           automation_retry_at = CASE WHEN $2 = 'codex' THEN NULL ELSE automation_retry_at END,
           claimed_at = COALESCE(claimed_at, NOW()),
           maintainer_note = COALESCE(NULLIF($4, ''), maintainer_note),
           updated_at = NOW()
       WHERE number = $1
       RETURNING *`,
      [
        numeric,
        requestedAssignee,
        automationState,
        normalizeText(note, 1000),
      ],
    );
    const next = updated.rows[0];

    await client.query(
      "INSERT INTO bug_report_events (bug_report_id, status, note, metadata) VALUES ($1, $2, $3, $4::jsonb)",
      [
        next.id,
        nextStatus,
        normalizeText(
          note,
          1000,
          requestedAssignee === "manual"
            ? "Atendimento manual iniciado pelo administrador."
            : "Atendimento automático iniciado pelo Allm4 Maintainer.",
        ),
        JSON.stringify({ assigned_to: requestedAssignee }),
      ],
    );

    return toMaintainerReport(next);
  });
}

export async function markBugAutomationUnavailable(number, reason = "", note = "") {
  await ensureBugSchema();
  const numeric = Number(number);
  if (!Number.isInteger(numeric) || numeric < 1) return null;

  return withTransaction(async (client) => {
    const result = await client.query(
      "SELECT * FROM bug_reports WHERE number = $1 FOR UPDATE",
      [numeric],
    );
    const row = result.rows[0];
    if (!row) return null;

    if (normalizeAssignee(row.assigned_to) === "manual") {
      throw claimConflict("bug_claim_conflict", "bug is reserved for manual handling");
    }

    const settings = await repairSettingsForClient(client);
    const retryEnabled =
      settings.triage_mode === "timed" && settings.auto_assign_codex;
    const safeReason = redactText(normalizeText(reason, 4000, "Codex indisponível."));
    const safeNote = redactText(
      normalizeText(
        note,
        2000,
        "Codex indisponível. O bug ficou disponível para atendimento manual e será tentado novamente depois.",
      ),
    );

    const updated = await client.query(
      `UPDATE bug_reports
       SET status = 'blocked',
           assigned_to = 'unassigned',
           automation_state = 'unavailable',
           automation_last_error = $2,
           automation_retry_at = CASE
             WHEN $3::boolean THEN NOW() + make_interval(mins => $4::int)
             ELSE NULL
           END,
           maintainer_note = $5,
           updated_at = NOW()
       WHERE number = $1
       RETURNING *`,
      [
        numeric,
        safeReason,
        retryEnabled,
        settings.codex_retry_minutes,
        safeNote,
      ],
    );
    const next = updated.rows[0];

    await client.query(
      "INSERT INTO bug_report_events (bug_report_id, status, note, metadata) VALUES ($1, 'blocked', $2, $3::jsonb)",
      [
        next.id,
        safeNote,
        JSON.stringify({
          assigned_to: "unassigned",
          automation_state: "unavailable",
          automation_retry_at: next.automation_retry_at,
        }),
      ],
    );

    return toMaintainerReport(next);
  });
}

export async function updateBugReport(number, patch = {}) {
  await ensureBugSchema();
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
           automation_state = CASE
             WHEN $2 IN ('resolved', 'update_available') THEN 'complete'
             ELSE automation_state
           END,
           automation_last_error = CASE
             WHEN $2 IN ('resolved', 'update_available') THEN NULL
             ELSE automation_last_error
           END,
           automation_retry_at = CASE
             WHEN $2 IN ('resolved', 'update_available') THEN NULL
             ELSE automation_retry_at
           END,
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
