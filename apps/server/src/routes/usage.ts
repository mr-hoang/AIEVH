import { Router } from "express";
import * as db from "../db.js";
import { priceFor } from "../pricing.js";

/** Thống kê token AI đã dùng - cột token trong danh sách project + biểu đồ Dashboard. */
const router = Router();

// GET /api/usage/summary → { byProject: { <id>: { tokens, costUsd } }, total: { tokens, costUsd, tokensIn, tokensOut } }
router.get("/summary", (_req, res) => {
  res.json({ byProject: db.tokensByProject(), total: db.usageTotals() });
});

// GET /api/usage/timeline?days=30&scope=all|video|image
// → [{ date, tokens, tokensIn, tokensOut, costUsd, byProvider }]
router.get("/timeline", (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const scope: db.UsageScope =
    req.query.scope === "video" || req.query.scope === "image" ? req.query.scope : "all";
  res.json(db.usageTimeline(days, scope));
});

// GET /api/usage/by-model?days=30
// → [{ provider, model, tokensIn, tokensOut, costUsd, price, costInUsd, costOutUsd }]
//
// costInUsd + costOutUsd === costUsd, LUÔN LUÔN. Đó là điểm mấu chốt.
//
// Bản đầu nhân thẳng token với đơn giá niêm yết để ra hai cột $, rồi để cạnh
// cột tiền thật. Kết quả trên máy người dùng: $2.055 + $27 nằm cạnh $402 - ba
// con số trong cùng một hàng tự mâu thuẫn nhau. Người dùng báo lại đúng chỗ đó,
// và họ đúng: một cái bảng mà số của chính nó không cộng lại được thì không có
// câu chú thích nào cứu nổi.
//
// Cách làm bây giờ: PHÂN BỔ chính số tiền thật ra hai chiều, lấy đơn giá niêm
// yết làm TỈ LỆ chứ không làm số tiền:
//     trọng số vào  = tokensIn  × giá vào
//     trọng số ra   = tokensOut × giá ra
//     $vào = tiền thật × (trọng số vào / tổng trọng số)
//     $ra  = tiền thật − $vào        ← trừ ra, không nhân lại, để không lệch số lẻ
//
// Nhờ vậy hàng nào cũng cộng đúng, mà vẫn trả lời được câu người dùng thật sự
// muốn hỏi: "tiền của tôi chảy vào chiều đọc hay chiều viết?".
//
// Model không có trong bảng giá thì không có tỉ lệ để chia → price = null, hai ô
// $ để null. Số tiền của dòng đó KHÔNG biến mất: nó vẫn nằm nguyên ở cột tổng,
// và giao diện nói rõ phần chưa phân bổ được là bao nhiêu.
router.get("/by-model", (req, res) => {
  const raw = Number(req.query.days);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(365, Math.max(1, raw)) : undefined;
  const rows = db.usageByModel(days).map((r) => {
    const price = priceFor(r.model, r.provider);
    if (!price) return { ...r, price: null, costInUsd: null, costOutUsd: null };

    const weightIn = (r.tokensIn / 1e6) * price.inPerM;
    const weightOut = (r.tokensOut / 1e6) * price.outPerM;
    const weight = weightIn + weightOut;
    // Không có token nào (hoặc giá 0) thì không chia được - dồn hết về chiều vào
    // để hai ô vẫn cộng đúng bằng cột tổng thay vì đẻ ra NaN.
    const costInUsd = weight > 0 ? (r.costUsd * weightIn) / weight : r.costUsd;
    return { ...r, price, costInUsd, costOutUsd: r.costUsd - costInUsd };
  });
  res.json(rows);
});

export default router;
