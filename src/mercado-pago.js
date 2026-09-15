import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { SecurityConfigurationError } from "./security.js";

const MERCADO_PAGO_API_BASE_URL = "https://api.mercadopago.com";
const SIGNATURE_DIAGNOSTIC_PREFIX_LENGTH = 12;

export class MercadoPagoApiError extends Error {
  constructor(status, payload = null) {
    super("mercado_pago_api_error");
    this.name = "MercadoPagoApiError";
    this.status = status;
    this.payload = payload;
  }
}

function getAccessToken() {
  const value = process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim();
  if (!value) {
    throw new SecurityConfigurationError("MERCADO_PAGO_ACCESS_TOKEN");
  }
  return value;
}

function getWebhookSecret() {
  const value = process.env.MERCADO_PAGO_WEBHOOK_SECRET?.trim();
  if (!value) {
    throw new SecurityConfigurationError("MERCADO_PAGO_WEBHOOK_SECRET");
  }
  return value;
}

export function formatAmountFromCents(amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new TypeError("Invalid amount");
  }
  return (amountCents / 100).toFixed(2);
}

export function buildPixOrderPayload({
  amountCents,
  externalReference,
  payerEmail,
  payerFirstName = null,
}) {
  const amount = formatAmountFromCents(amountCents);
  const payer = { email: payerEmail };

  if (payerFirstName) {
    payer.first_name = payerFirstName;
  }

  return {
    type: "online",
    total_amount: amount,
    external_reference: externalReference,
    processing_mode: "automatic",
    transactions: {
      payments: [
        {
          amount,
          payment_method: {
            id: "pix",
            type: "bank_transfer",
          },
          expiration_time: "PT30M",
        },
      ],
    },
    payer,
  };
}

async function mercadoPagoRequest(
  path,
  { method = "GET", body = null, idempotencyKey = null, fetchImpl = fetch } = {},
) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${getAccessToken()}`,
  };

  if (body !== null) {
    headers["Content-Type"] = "application/json";
  }

  if (idempotencyKey) {
    headers["X-Idempotency-Key"] = idempotencyKey;
  }

  const response = await fetchImpl(`${MERCADO_PAGO_API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 1000) };
    }
  }

  if (!response.ok) {
    throw new MercadoPagoApiError(response.status, payload);
  }

  return payload;
}

export async function createPixOrder({
  amountCents,
  externalReference,
  payerEmail,
  payerFirstName = null,
  fetchImpl = fetch,
}) {
  const payload = buildPixOrderPayload({
    amountCents,
    externalReference,
    payerEmail,
    payerFirstName,
  });

  return mercadoPagoRequest("/v1/orders", {
    method: "POST",
    body: payload,
    idempotencyKey: randomUUID(),
    fetchImpl,
  });
}

export async function getMercadoPagoOrder(orderId, { fetchImpl = fetch } = {}) {
  return mercadoPagoRequest(`/v1/orders/${encodeURIComponent(orderId)}`, {
    fetchImpl,
  });
}

export function extractPixDetails(order) {
  const payment = order?.transactions?.payments?.[0] ?? null;
  const paymentMethod = payment?.payment_method ?? null;

  return {
    order_id: order?.id ?? null,
    order_status: order?.status ?? null,
    order_status_detail: order?.status_detail ?? null,
    payment_id: payment?.id ?? null,
    payment_status: payment?.status ?? null,
    payment_status_detail: payment?.status_detail ?? null,
    qr_code: paymentMethod?.qr_code ?? null,
    qr_code_base64: paymentMethod?.qr_code_base64 ?? null,
    ticket_url: paymentMethod?.ticket_url ?? null,
  };
}

export function buildMercadoPagoWebhookManifest({
  dataId = null,
  xRequestId = null,
  timestamp = null,
}) {
  let manifest = "";

  if (typeof dataId === "string" && dataId.trim()) {
    manifest += `id:${dataId.trim()};`;
  }
  if (typeof xRequestId === "string" && xRequestId.trim()) {
    manifest += `request-id:${xRequestId.trim()};`;
  }
  if (typeof timestamp === "string" && timestamp.trim()) {
    manifest += `ts:${timestamp.trim()};`;
  }

  return manifest;
}

function parseWebhookSignature(xSignature) {
  if (typeof xSignature !== "string" || !xSignature.trim()) {
    return null;
  }

  const values = {};
  for (const part of xSignature.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim().toLowerCase();
    const value = part.slice(separatorIndex + 1).trim();
    if (key && value) {
      values[key] = value;
    }
  }

  if (!values.ts || !values.v1 || !/^[a-f0-9]{64}$/i.test(values.v1)) {
    return null;
  }

  return {
    timestamp: values.ts,
    hash: values.v1.toLowerCase(),
  };
}

function webhookSignatureMatchesManifest({ manifest, receivedHash, secret }) {
  const expectedHash = createHmac("sha256", secret)
    .update(manifest, "utf8")
    .digest();

  return (
    receivedHash.length === expectedHash.length &&
    timingSafeEqual(receivedHash, expectedHash)
  );
}

function hmacPrefix(manifest, secret) {
  if (!manifest) {
    return null;
  }

  return createHmac("sha256", secret)
    .update(manifest, "utf8")
    .digest("hex")
    .slice(0, SIGNATURE_DIAGNOSTIC_PREFIX_LENGTH);
}

export function getMercadoPagoWebhookSignatureDiagnostics({
  xSignature,
  xRequestId = null,
  dataId = null,
}) {
  const parsed = parseWebhookSignature(xSignature);
  const normalizedDataId =
    typeof dataId === "string" && dataId.trim() ? dataId.trim() : null;

  if (!parsed) {
    return {
      signature_format_valid: false,
      request_id: xRequestId ?? null,
      data_id: normalizedDataId,
    };
  }

  const secret = getWebhookSecret();
  const lowercaseDataId = normalizedDataId?.toLowerCase() ?? null;
  const exactManifest = buildMercadoPagoWebhookManifest({
    dataId: normalizedDataId,
    xRequestId,
    timestamp: parsed.timestamp,
  });
  const lowercaseManifest = buildMercadoPagoWebhookManifest({
    dataId: lowercaseDataId,
    xRequestId,
    timestamp: parsed.timestamp,
  });
  const exactWithoutRequestIdManifest = buildMercadoPagoWebhookManifest({
    dataId: normalizedDataId,
    timestamp: parsed.timestamp,
  });
  const lowercaseWithoutRequestIdManifest = buildMercadoPagoWebhookManifest({
    dataId: lowercaseDataId,
    timestamp: parsed.timestamp,
  });

  return {
    signature_format_valid: true,
    request_id: xRequestId ?? null,
    data_id: normalizedDataId,
    timestamp: parsed.timestamp,
    exact_manifest: exactManifest,
    lowercase_manifest: lowercaseManifest,
    exact_without_request_id_manifest: exactWithoutRequestIdManifest,
    lowercase_without_request_id_manifest: lowercaseWithoutRequestIdManifest,
    received_v1_prefix: parsed.hash.slice(0, SIGNATURE_DIAGNOSTIC_PREFIX_LENGTH),
    computed_exact_prefix: hmacPrefix(exactManifest, secret),
    computed_lowercase_prefix: hmacPrefix(lowercaseManifest, secret),
    computed_without_request_id_prefix: hmacPrefix(
      exactWithoutRequestIdManifest,
      secret,
    ),
    computed_lowercase_without_request_id_prefix: hmacPrefix(
      lowercaseWithoutRequestIdManifest,
      secret,
    ),
    secret_fingerprint: createHash("sha256")
      .update(secret, "utf8")
      .digest("hex")
      .slice(0, SIGNATURE_DIAGNOSTIC_PREFIX_LENGTH),
  };
}

export function validateMercadoPagoWebhookSignature({
  xSignature,
  xRequestId = null,
  dataId = null,
}) {
  const parsed = parseWebhookSignature(xSignature);
  if (!parsed) {
    return false;
  }

  const normalizedDataId =
    typeof dataId === "string" && dataId.trim() ? dataId.trim() : null;
  const manifests = [
    buildMercadoPagoWebhookManifest({
      dataId: normalizedDataId,
      xRequestId,
      timestamp: parsed.timestamp,
    }),
  ];

  if (normalizedDataId) {
    const lowercaseDataId = normalizedDataId.toLowerCase();
    if (lowercaseDataId !== normalizedDataId) {
      manifests.push(
        buildMercadoPagoWebhookManifest({
          dataId: lowercaseDataId,
          xRequestId,
          timestamp: parsed.timestamp,
        }),
      );
    }
  }

  if (manifests.every((manifest) => !manifest)) {
    return false;
  }

  const secret = getWebhookSecret();
  const receivedHash = Buffer.from(parsed.hash, "hex");

  return manifests.some(
    (manifest) =>
      manifest &&
      webhookSignatureMatchesManifest({ manifest, receivedHash, secret }),
  );
}
