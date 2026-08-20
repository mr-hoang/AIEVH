import { Router } from "express";
import * as db from "../db.js";
import { scanProjects } from "../meta.js";
import { getHealth } from "./health.js";

const router = Router();

// GET /api/overview - dữ liệu tổng hợp cho dashboard
router.get("/", async (_req, res) => {
  // Queue chạy song song tối đa 4 job - lấy đủ danh sách, không chỉ 1
  const running = db.getRunningJobs();
  const recentJobs = db.listJobs(5).map(db.jobToApi);
  // Join token usage như GET /api/projects - thiếu join là cột TOKEN trên Dashboard = 0
  const usage = db.tokensByProject();
  const recentProjects = scanProjects()
    .slice(0, 6)
    .map((s) => ({
      ...s,
      tokensUsed: usage[s.id]?.tokens ?? 0,
      costUsd: usage[s.id]?.costUsd ?? 0,
    }));
  const health = await getHealth();

  res.json({
    // Field cũ giữ cho tương thích - job đang chạy đầu tiên (null nếu không có)
    runningJob: running.length > 0 ? db.jobToApi(running[0]) : null,
    runningJobs: running.map(db.jobToApi),
    queuedCount: db.countQueuedJobs(),
    recentJobs,
    recentProjects,
    health,
  });
});

export default router;
