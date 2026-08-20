export function ProgressBar({
  progress,
  step,
}: {
  progress: number;
  step?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-subtle)]">
        <div
          className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-150 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* step là chuỗi tự do (có khi là cả dòng lỗi dài) - shrink-0 ở đây từng
          đẩy toác cả cột workspace và sinh thanh cuộn ngang cho cả trang.
          Chỉ % là bất di bất dịch, phần chữ co lại và cắt bớt, giữ nguyên văn
          trong title để rê chuột vẫn đọc được. */}
      <span className="flex min-w-0 shrink items-baseline gap-1 text-xs text-[var(--text-muted)]">
        <span className="shrink-0">{pct}%</span>
        {step ? (
          <span className="min-w-0 truncate" title={step}>
            · {step}
          </span>
        ) : null}
      </span>
    </div>
  );
}
