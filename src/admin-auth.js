import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function getProvidedSecret(req) {
  const headerSecret = req.get("x-admin-secret")?.trim();
  if (headerSecret) {
    return headerSecret;
  }

  const authorization = req.get("authorization")?.trim();
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return null;
}

export function requireAdmin(req, res, next) {
  const configuredSecret = process.env.ADMIN_SECRET?.trim();
  if (!configuredSecret) {
    return res.status(503).json({
      ok: false,
      error: "admin_not_configured",
    });
  }

  const providedSecret = getProvidedSecret(req);
  if (!providedSecret || !timingSafeEqual(digest(configuredSecret), digest(providedSecret))) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  return next();
}
