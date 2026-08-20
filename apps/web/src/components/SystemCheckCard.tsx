"use client";

/**
 * Card "Kiểm tra hệ thống" - trang Cấu hình.
 *
 * Nguồn dữ liệu là start/doctor.mjs (dùng chung với start.ps1/start.sh) qua
 * GET /api/doctor, nên bảng này không bao giờ lệch với lúc khởi động.
 *
 * Nguyên tắc trình bày: thiếu thứ gì thì ngay cạnh nó phải có ĐƯỜNG SỬA -
 * nút cài tự động, hoặc link tới trang xử lý được, hoặc lệnh copy một phát.
 * Đủ hết rồi thì thu gọn thành một dòng để không chiếm chỗ.
 */

import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  Minus,
  RotateCcw,
} from "lucide-react";
import { LinkButton } from "@/components/LinkButton";
import { useCallback, useEffect, useState } from "react";
import {
  getDoctor,
  fixDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CopyButton } from "@/components/CopyButton";
import { useT } from "@/lib/i18n";

/** Nhãn ưu tiên bản dịch (Claude login → Đăng nhập Claude); thiếu thì dùng tên riêng từ server */
function useLabel() {
  const { t } = useT();
  return (c: DoctorCheck) => {
    const key = `doctor.label.${c.id}`;
    const translated = t(key);
    return translated === key ? c.label : translated;
  };
}

function StatusIcon({ check }: { check: DoctorCheck }) {
  if (check.level === "info") {
    return <Minus size={15} strokeWidth={2} className="text-[var(--text-muted)]" />;
  }
  if (check.status === "ok") {
    return <Check size={15} strokeWidth={2.5} className="text-[var(--success)]" />;
  }
  // Thiếu tính năng phụ không phải lỗi đỏ - đừng dọa người dùng
  const tone = check.level === "required" ? "var(--danger)" : "var(--text-muted)";
  return <AlertTriangle size={15} strokeWidth={2} style={{ color: tone }} />;
}

function CheckRow({
  check,
  onFixed,
}: {
  check: DoctorCheck;
  onFixed: (report: DoctorReport) => void;
}) {
  const { t, tf } = useT();
  const label = useLabel();
  const [busy, setBusy] = useState(false);
  const [failLog, setFailLog] = useState<string[] | null>(null);

  const install = async () => {
    setBusy(true);
    setFailLog(null);
    try {
      const res = await fixDoctor(check.id);
      onFixed(res.report);
      // Chỉ coi là cài LỖI khi server nói rõ installed === false - field vắng
      // mặt (server cũ / nhánh trả sớm) không được suy ra thất bại
      if (res.installed === false)
        setFailLog(res.log.length > 0 ? res.log : [t("doctor.install-failed")]);
    } catch (e) {
      setFailLog([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const noteText = check.note ? t(`doctor.note.${check.note}`) : "";
  const sub = [check.detail, noteText].filter(Boolean).join(" · ");
  const missing = check.status === "missing" && check.level !== "info";
  const fix = check.fix;

  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
      <span className="mt-0.5 shrink-0">
        <StatusIcon check={check} />
      </span>
      <div className="min-w-0 flex-1">
        {/* Tên check và câu mô tả đi cùng nó đều là NỘI DUNG - trước đây câu mô
            tả nhỏ hơn hẳn một bậc nên cả bảng đọc thành một khối xám */}
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{label(check)}</span>
          {sub && (
            <span className="min-w-0 break-all text-sm text-[var(--text-muted)]">
              {sub}
            </span>
          )}
        </div>
        {missing && (
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">
            {t(`doctor.why.${check.id}`)}
          </p>
        )}
        {/* Lệnh chạy được thì cho vào khối code (chép được); còn lại là chỉ dẫn
            bằng lời, để chữ thường cho khỏi trông như lệnh gõ vào terminal */}
        {missing && !fix?.auto && fix?.command && (
          <code className="mt-1 inline-block max-w-full break-all rounded-[var(--radius)] bg-[var(--bg-subtle)] px-2 py-1 font-mono text-meta text-[var(--text-muted)]">
            {fix.command}
          </code>
        )}
        {missing && !fix?.auto && !fix?.command && fix?.manual && (
          <p className="mt-1 text-sm text-[var(--text-muted)]">{fix.manual}</p>
        )}
        {failLog && (
          <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-[var(--radius)] bg-[var(--danger-bg)] px-2 py-1.5 font-mono text-meta text-[var(--text)]">
            {failLog.join("\n")}
          </pre>
        )}
      </div>

      {missing && (
        // w-full dưới sm: nhóm nút chiếm trọn một hàng riêng thay vì chen cạnh
        // phần chữ rồi tràn ra ngoài card (đo được ở 500px và 380px)
        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
          {fix?.auto && (
            <Button small onClick={install} disabled={busy}>
              {busy ? (
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <Download size={13} strokeWidth={2} />
              )}
              {busy
                ? t("doctor.installing")
                : fix.size
                  ? tf("doctor.install-size", { size: fix.size })
                  : t("doctor.install")}
            </Button>
          )}
          {!fix?.auto && fix?.link && (
            <LinkButton small href={fix.link}>
              {t("doctor.open-page")}
            </LinkButton>
          )}
          {!fix?.auto && fix?.command && (
            <CopyButton value={fix.command} label={t("doctor.copy")} />
          )}
          {!fix?.auto && fix?.url && (
            <LinkButton small external href={fix.url}>
              <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
              {t("doctor.guide")}
            </LinkButton>
          )}
        </div>
      )}
    </div>
  );
}

export function SystemCheckCard() {
  const { t, tf } = useT();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setChecking(true);
    try {
      setReport(await getDoctor(refresh));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const missingRequired =
    report?.checks.filter((c) => c.level === "required" && c.status === "missing") ?? [];
  const missingOptional =
    report?.checks.filter((c) => c.level === "optional" && c.status === "missing") ?? [];
  const hasProblem = missingRequired.length > 0 || missingOptional.length > 0;
  // Đủ hết thì mặc định thu gọn - card này chỉ cần nổi bật khi có việc phải làm
  const showAll = expanded || hasProblem;

  const title = t("doctor.title");
  const hint = { titleKey: "help.doctor.title", bodyKey: "help.doctor.body" };

  const actions = (
    <Button variant="secondary" small onClick={() => void load(true)} disabled={checking}>
      {checking ? (
        <Loader2 size={13} strokeWidth={2} className="animate-spin" />
      ) : (
        <RotateCcw size={13} strokeWidth={2} />
      )}
      {t("doctor.recheck")}
    </Button>
  );

  if (error) {
    return (
      <Card title={title} hint={hint} actions={actions}>
        <Banner tone="danger" message={error} />
      </Card>
    );
  }

  if (!report) {
    // Có nhãn chứ không phải khung xám trơn: lần dò đầu mất ~6s, khung trống
    // suốt 6s trông như trang bị hỏng
    return (
      <Card title={title} hint={hint}>
        <span className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 size={14} strokeWidth={2} className="animate-spin" />
          {t("doctor.checking")}
        </span>
      </Card>
    );
  }

  return (
    <Card title={title} hint={hint} actions={actions}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {missingRequired.length === 0 ? (
          <Badge tone="success" label={t("doctor.all-good")} />
        ) : (
          <Badge
            tone="danger"
            label={tf("doctor.missing-required", {
              n: missingRequired.length,
            })}
          />
        )}
        {missingOptional.length > 0 && (
          <Badge
            tone="muted"
            label={tf("doctor.missing-optional", {
              n: missingOptional.length,
            })}
          />
        )}
        <span className="grow" />
        {!hasProblem && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 text-meta font-medium text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
          >
            <ChevronDown
              size={13}
              strokeWidth={2}
              className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
            />
            {expanded ? t("doctor.hide") : t("doctor.details")}
          </button>
        )}
      </div>

      {showAll && (
        <div className="mt-2 divide-y divide-[var(--border)] border-t border-[var(--border)] pt-1">
          {report.checks
            // Có việc phải làm thì đẩy các mục thiếu lên trên
            .slice()
            .sort((a, b) => {
              const rank = (c: DoctorCheck) =>
                c.status === "missing" && c.level === "required"
                  ? 0
                  : c.status === "missing" && c.level === "optional"
                    ? 1
                    : 2;
              return rank(a) - rank(b);
            })
            .map((c) => (
              <CheckRow key={c.id} check={c} onFixed={setReport} />
            ))}
        </div>
      )}
    </Card>
  );
}
