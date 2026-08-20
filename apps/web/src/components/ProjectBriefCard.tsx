"use client";

import { Check, ChevronDown, ChevronUp, Minus, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { updateBrief, type Brief } from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { ErrorBanner } from "@/components/ErrorBanner";
import {
  BriefFields,
  DEFAULT_BRIEF,
  MUSIC_MODE_LABEL,
  SFX_MODE_LABEL,
} from "@/components/BriefFields";
import { styleDisplayName, useStyles } from "@/components/StyleSelect";
import { useT } from "@/lib/i18n";

// Các hằng của brief nay nằm ở BriefFields (dùng chung với Auto cut videos).
// Re-export để nơi đang import từ đây không phải sửa.
export { DEFAULT_BRIEF, MUSIC_MODE_LABEL, SFX_MODE_LABEL };

/**
 * Badge Có/Không cho tóm tắt compact.
 *
 * `dot={false}`: đây là nhãn PHÂN LOẠI ("có bật cắt tự động hay không"), không
 * phải trạng thái đang chạy - chấm tròn ở đây bị đọc nhầm thành "đang xử lý".
 * Dấu tick / gạch ngang đã nói đủ nghĩa bật/tắt.
 */
function YesNoBadge({ label, value }: { label: string; value: boolean }) {
  return (
    <Badge
      tone={value ? "success" : "muted"}
      dot={false}
      label={
        <>
          {value ? (
            <Check size={12} strokeWidth={2.5} className="shrink-0" />
          ) : (
            <Minus size={12} strokeWidth={2.5} className="shrink-0" />
          )}
          {label}
        </>
      }
    />
  );
}

export function ProjectBriefCard({
  projectId,
  brief,
  onSaved,
  onDraftChange,
  compact = false,
}: {
  projectId: string;
  brief: Brief | undefined;
  onSaved: (brief: Brief) => void;
  /** Báo bản nháp hiện tại lên parent mỗi lần gõ - modal "Bắt đầu edit" dùng giá trị này */
  onDraftChange?: (brief: Brief) => void;
  /** Chế độ gọn sau khi đã bắt đầu edit - tóm tắt chỉ đọc, bấm "Chỉnh sửa" mở form đầy đủ. */
  compact?: boolean;
}) {
  const { t } = useT();
  const [form, setForm] = useState<Brief>(DEFAULT_BRIEF);
  // compact: đang mở form đầy đủ in-place hay chỉ hiện tóm tắt
  const [expandedForm, setExpandedForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Style Design - cache module-level, tên style dùng ở tóm tắt compact
  const { data: stylesData } = useStyles();

  // Nạp giá trị từ project detail một lần khi brief về (không clobber khi đang gõ)
  const initialized = useRef(false);
  // Field người dùng đã gõ TRƯỚC khi brief thật về - đè lên bản fetch lúc nạp,
  // để fetch chậm không nuốt mất mấy phím vừa gõ.
  const preInitEdits = useRef<Partial<Brief>>({});
  useEffect(() => {
    if (brief && !initialized.current) {
      initialized.current = true;
      const initial = { ...DEFAULT_BRIEF, ...brief, ...preInitEdits.current };
      setForm(initial);
      onDraftChange?.(initial);
    }
  }, [brief, onDraftChange]);

  function patch(p: Partial<Brief>) {
    setSaved(false);
    if (!initialized.current) {
      preInitEdits.current = { ...preInitEdits.current, ...p };
    }
    setForm((f) => {
      const next = { ...f, ...p };
      onDraftChange?.(next);
      return next;
    });
  }

  async function onSave() {
    // Brief thật chưa nạp về (mạng chậm/lỗi) mà lưu là ghi đè mọi thứ bằng default
    if (!initialized.current) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateBrief(projectId, form);
      setForm({ ...DEFAULT_BRIEF, ...result });
      setSaved(true);
      onSaved(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Compact + chưa bấm "Chỉnh sửa" → chỉ hiện tóm tắt chỉ đọc
  const showSummary = compact && !expandedForm;

  // Chú thích (i) chỉ đặt ở tiêu đề card (prop `hint` của Card), các toggle bên
  // trong đã có dòng mô tả riêng
  const cardHint = { titleKey: "help.brief.title", bodyKey: "help.brief.body" };

  const summaryRowLabel =
    "w-24 shrink-0 pt-px text-meta text-[var(--text-muted)]";
  const summary = (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex gap-2">
        <span className={summaryRowLabel}>{t("brief.sum-source")}</span>
        <span className="min-w-0 flex-1 truncate">
          {form.sourceDescription.trim() || (
            <span className="text-[var(--text-muted)]">{t("brief.not-described")}</span>
          )}
        </span>
      </div>
      <div className="flex gap-2">
        <span className={summaryRowLabel}>{t("brief.edit-request")}</span>
        <span className="min-w-0 flex-1">
          {form.notes.trim() ? (
            <span className="line-clamp-2 whitespace-pre-line">
              {form.notes}
            </span>
          ) : (
            <span className="text-[var(--text-muted)]">{t("brief.none")}</span>
          )}
        </span>
      </div>
      <div className="flex gap-2">
        <span className={summaryRowLabel}>{t("brief.sum-options")}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <YesNoBadge label={t("brief.badge-cut")} value={form.autoCut} />
          <YesNoBadge label={t("brief.subtitles")} value={form.subtitles} />
          <YesNoBadge label="Highlight" value={form.highlightEnabled} />
          <YesNoBadge label={t("brief.key-layout")} value={form.keyLayoutEnabled} />
          <YesNoBadge label={t("brief.badge-illustrations")} value={form.autoIllustrations} />
          {/* Phong cách dựng giờ là công tắc như mấy cái trên - vào đúng hàng
              badge này, đừng để nó là thứ duy nhất phải mở form ra mới biết */}
          <YesNoBadge label={t("vstyle.label")} value={form.videoStyleEnabled} />
        </span>
      </div>
      <div className="flex gap-2">
        <span className={summaryRowLabel}>Style Design</span>
        <span className="min-w-0 flex-1 truncate">
          {styleDisplayName(stylesData, form.styleId, t)}
        </span>
      </div>
      <div className="flex gap-2">
        <span className={summaryRowLabel}>Skill</span>
        <span className="min-w-0 flex-1 truncate">
          {form.skill ?? t("brief.ai-pick-skill")}
        </span>
      </div>
      <div className="flex gap-2">
        <span className={summaryRowLabel}>Sound effect</span>
        <span className="min-w-0 flex-1 truncate">
          {t(SFX_MODE_LABEL[form.sfxMode])}
        </span>
      </div>
    </div>
  );

  if (showSummary) {
    return (
      <Card
        title={t("brief.title")}
        hint={cardHint}
        actions={
          // Nhãn nói về việc MỞ RỘNG chứ không phải "Sửa": ở project đã xong,
          // người dùng bấm vào đây chủ yếu để xem lại cấu hình đã dùng.
          <Button
            variant="secondary"
            small
            onClick={() => setExpandedForm(true)}
          >
            <ChevronDown size={13} strokeWidth={2} />
            {t("brief.expand")}
          </Button>
        }
      >
        {summary}
      </Card>
    );
  }

  return (
    <Card
      title={t("brief.title")}
      hint={cardHint}
      actions={
        compact ? (
          <Button
            variant="secondary"
            small
            onClick={() => setExpandedForm(false)}
          >
            <ChevronUp size={13} strokeWidth={2} />
            {t("brief.collapse")}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <ErrorBanner message={t("brief.save-error")} detail={error} />
        )}

        <BriefFields value={form} onChange={patch} projectId={projectId} />

        <div className="flex items-center gap-3">
          <Button onClick={onSave} disabled={saving || !brief}>
            <Save size={15} strokeWidth={2} />
            {saving ? t("common.saving") : t("brief.save")}
          </Button>
          {saved && (
            <span className="text-sm font-medium text-[var(--success)]">
              {t("brief.saved")}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
