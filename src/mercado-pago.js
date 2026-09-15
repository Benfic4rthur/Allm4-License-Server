import { randomUUID } from "node:crypto";
import { SecurityConfigurationError } from "./security.js";

const MERCADO_PAGO_API_BASE_URL = "https://api.mercadopago.com";

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
