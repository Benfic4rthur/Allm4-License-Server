import express from "express";
import { syncFreeUsage } from "./free-usage-service.js";

const router = express.Router();

router.post("/free-usage/sync", async (req, res) => {
  try {
    const state = await syncFreeUsage({
      deviceId: req.body?.device_id,
      installationCount: req.body?.installation_count,
      usedCount: req.body?.used_count,
    });

    res.status(200).json({
      ok: true,
      free_usage: state,
    });
  } catch (error) {
    if (error instanceof TypeError) {
      return res.status(400).json({
        ok: false,
        error: "invalid_free_usage_state",
      });
    }

    console.error("[Free usage] sync failed", error);
    res.status(500).json({
      ok: false,
      error: "free_usage_sync_failed",
    });
  }
});

export default router;
