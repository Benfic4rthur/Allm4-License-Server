import express from "express";
import { listPublishedSiteCoupons } from "./coupon-public-service.js";

const router = express.Router();

router.get("/public/coupons", async (_req, res) => {
  try {
    const coupons = await listPublishedSiteCoupons();
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, coupons });
  } catch (error) {
    console.error("[Coupon Public API] unexpected error", error);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
