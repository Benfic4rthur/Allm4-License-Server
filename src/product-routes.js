import express from "express";
import { getAlmaProductSettings } from "./product-settings-service.js";

const router = express.Router();

router.get("/product", async (_req, res) => {
  try {
    const product = await getAlmaProductSettings();
    return res.status(200).json({ ok: true, product });
  } catch (error) {
    console.error("[Product API] unexpected error", error);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
