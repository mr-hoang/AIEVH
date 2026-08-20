"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { UsageTimelinePoint } from "@/lib/api";
import { formatTokens, formatUsd } from "@/lib/format";
import { useT } from "@/lib/i18n";

/**
 * Combo chart SVG thuần - token AI theo ngày.
 * CỘT = tổng token/ngày (--primary mờ 0.35, làm nền), ĐƯỜNG + chấm = token
 * theo từng AI. Màu series đi qua token: Claude --primary, Gemini --chart-2,
 * OpenAI --chart-3 (bộ 3 đã validate CVD/contrast bằng validator dataviz,
 * light lẫn dark - xem comment trong globals.css). Provider không có dữ liệu
 * thì không vẽ đường và không hiện trong legend. Một trục Y duy nhất - đường
 * luôn ≤ cột tổng nên chung thang đo.
 *
 * Chiều rộng SVG đo theo container (ResizeObserver) để 1 unit = 1 px thật -
 * KHÔNG dùng viewBox cố định + width 100%, vì khi card rộng hơn viewBox thì
 * cả chữ trục bị phóng to theo (bug "số quá to").
 */

const H = 220;
const PAD_L = 40;
const PAD_R = 6;
const PAD_T = 10;
const PAD_B = 20;
const AXIS_FONT = 10;

/** Thứ tự series CỐ ĐỊNH - màu theo entity, không theo rank (dataviz). */
const PROVIDERS = [
  { id: "claude", label: "Claude", color: "var(--primary)" },
  { id: "gemini", label: "Gemini", color: "var(--chart-2)" },
  { id: "openai", label: "OpenAI", color: "var(--chart-3)" },
] as const;

/** Trần "đẹp" cho trục Y: 1 / 2 / 5 × 10^k. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / base;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * base;
}

/** Cột đỉnh bo tròn, chân neo thẳng vào baseline. */
function barPath(x: number, w: number, top: number, baseline: number): string {
  const h = baseline - top;
  if (h <= 0) return "";
  const r = Math.min(3, w / 2, h);
  return [
    `M${x},${baseline}`,
    `L${x},${top + r}`,
    `Q${x},${top} ${x + r},${top}`,
    `L${x + w - r},${top}`,
    `Q${x + w},${top} ${x + w},${top + r}`,
    `L${x + w},${baseline}`,
    "Z",
  ].join(" ");
}

/** yyyy-mm-dd theo giờ địa phương. */
function localKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const fmtDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmtDayFull = (iso: string) =>
  `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function TokenTimelineChart({
  data,
  days = 30,
}: {
  data: UsageTimelinePoint[];
  days?: number;
}) {
  const { t, tf } = useT();
  const [hover, setHover] = useState<number | null>(null);

  // Đo chiều rộng container - SVG vẽ đúng scale 1:1, chữ giữ nguyên px
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0;
      if (cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Lấp đủ `days` ngày liên tục kết thúc hôm nay - ngày không có data = 0
  const series = useMemo(() => {
    const byDate = new Map(data.map((d) => [d.date, d]));
    const out: UsageTimelinePoint[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = localKey(d);
      const found = byDate.get(key);
      out.push({
        date: key,
        tokens: found?.tokens ?? 0,
        tokensIn: found?.tokensIn ?? 0,
        tokensOut: found?.tokensOut ?? 0,
        costUsd: found?.costUsd ?? 0,
        byProvider: found?.byProvider ?? {},
      });
    }
    return out;
  }, [data, days]);

  // Chỉ vẽ đường/legend cho provider thực sự có token trong khoảng thời gian
  const activeProviders = useMemo(
    () =>
      PROVIDERS.filter((p) =>
        series.some((d) => (d.byProvider[p.id] ?? 0) > 0)
      ),
    [series]
  );

  const n = series.length;
  const max = niceMax(Math.max(0, ...series.map((d) => d.tokens)));
  const baseline = H - PAD_B;
  const plotW = W - PAD_L - PAD_R;
  const plotH = baseline - PAD_T;
  const slot = plotW / n;
  const barW = Math.max(2, slot - 2); // khe 2px giữa các cột (mark spec)
  const y = (v: number) => baseline - (v / max) * plotH;
  const cx = (i: number) => PAD_L + slot * (i + 0.5);

  // Nhãn ngày thưa - chỉ ~6 mốc
  const labelStep = Math.max(1, Math.ceil(n / 6));

  const hovered = hover != null ? series[hover] : null;
  const hoverPct = hover != null ? (cx(hover) / W) * 100 : 0;
  const hoverTransform =
    hoverPct < 18
      ? "none"
      : hoverPct > 82
        ? "translateX(-100%)"
        : "translateX(-50%)";

  return (
    <div className="relative" ref={wrapRef}>
      {hovered && (
        <div
          className="pointer-events-none absolute top-0 z-10"
          style={{ left: `${hoverPct}%`, transform: hoverTransform }}
        >
          <div className="whitespace-nowrap rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-card)]">
            <div className="font-medium">{fmtDayFull(hovered.date)}</div>
            <div className="text-[var(--text-muted)]">
              {tf("chart.total-tokens", {
                n: hovered.tokens.toLocaleString("vi-VN"),
              })}
              {hovered.costUsd > 0 && ` · ${formatUsd(hovered.costUsd)}`}
            </div>
            {(hovered.tokensIn > 0 || hovered.tokensOut > 0) && (
              <div className="text-[var(--text-muted)]">
                In {formatTokens(hovered.tokensIn)} · Out{" "}
                {formatTokens(hovered.tokensOut)}
              </div>
            )}
            {activeProviders.map((p) => {
              const v = hovered.byProvider[p.id] ?? 0;
              if (v <= 0) return null;
              return (
                <div key={p.id} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: p.color }}
                  />
                  <span className="text-[var(--text-muted)]">
                    {p.label}: {v.toLocaleString("vi-VN")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={tf("chart.aria", { days })}
        onMouseLeave={() => setHover(null)}
      >
        {/* Grid ngang recessive + nhãn trục Y */}
        {[max / 2, max].map((v) => (
          <g key={v}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <text
              x={PAD_L - 8}
              y={y(v) + 3.5}
              textAnchor="end"
              fontSize={AXIS_FONT}
              fill="var(--text-muted)"
            >
              {formatTokens(v)}
            </text>
          </g>
        ))}
        <text
          x={PAD_L - 8}
          y={baseline + 3.5}
          textAnchor="end"
          fontSize={AXIS_FONT}
          fill="var(--text-muted)"
        >
          0
        </text>
        {/* Trục X (baseline) */}
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={baseline}
          y2={baseline}
          stroke="var(--border)"
          strokeWidth={1}
        />

        {/* Cột tổng token/ngày - mờ để nhường sân cho đường provider */}
        {series.map((d, i) => (
          <path
            key={d.date}
            d={barPath(PAD_L + slot * i + 1, barW, y(d.tokens), baseline)}
            fill="var(--primary)"
            fillOpacity={hover === i ? 0.55 : 0.35}
          />
        ))}

        {/* Đường theo từng AI - polyline qua mọi ngày (ngày không dùng = 0) */}
        {activeProviders.map((p) => (
          <polyline
            key={p.id}
            points={series
              .map((d, i) => `${cx(i)},${y(d.byProvider[p.id] ?? 0)}`)
              .join(" ")}
            fill="none"
            stroke={p.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Chấm nhỏ tại ngày provider có data - viền surface tách khỏi cột */}
        {activeProviders.map((p) =>
          series.map((d, i) => {
            const v = d.byProvider[p.id] ?? 0;
            if (v <= 0) return null;
            return (
              <circle
                key={`${p.id}-${d.date}`}
                cx={cx(i)}
                cy={y(v)}
                r={hover === i ? 3.5 : 2.5}
                fill={p.color}
                stroke="var(--surface)"
                strokeWidth={1}
              />
            );
          })
        )}

        {/* Nhãn ngày thưa */}
        {series.map((d, i) =>
          i % labelStep === 0 ? (
            <text
              key={d.date}
              x={cx(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize={AXIS_FONT}
              fill="var(--text-muted)"
            >
              {fmtDay(d.date)}
            </text>
          ) : null
        )}

        {/* Vùng bắt hover/focus - rộng hơn mark (hit target ≥ mark) */}
        {series.map((d, i) => (
          <rect
            key={d.date}
            x={PAD_L + slot * i}
            y={PAD_T}
            width={slot}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            aria-label={`${fmtDayFull(d.date)}: ${d.tokens.toLocaleString("vi-VN")} token${
              d.costUsd > 0 ? `, ${formatUsd(d.costUsd)}` : ""
            }`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover((h) => (h === i ? null : h))}
          />
        ))}
      </svg>

      {/* Legend - chỉ provider có dữ liệu; chữ dùng token text, màu nằm ở chip */}
      {activeProviders.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {activeProviders.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1 text-xs leading-none text-[var(--text-muted)]"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: p.color }}
              />
              {p.label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1 text-xs leading-none text-[var(--text-muted)]">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-[2px]"
              style={{ background: "var(--primary)", opacity: 0.35 }}
            />
            {t("chart.total-per-day")}
          </span>
        </div>
      )}
    </div>
  );
}
