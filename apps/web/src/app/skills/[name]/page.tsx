"use client";

import { ArrowLeft, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { deleteSkill, getSkill, updateSkill } from "@/lib/api";
import { Card } from "@/components/Card";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/Skeleton";
import { useT } from "@/lib/i18n";

export default function SkillDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();
  const { t } = useT();

  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let stale = false;
    getSkill(name)
      .then((s) => {
        if (stale) return;
        setContent(s.content);
        setDirty(false);
        setError(null);
      })
      .catch((e) => {
        if (stale) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      stale = true;
    };
  }, [name]);

  async function onSave() {
    if (content == null || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateSkill(name, content);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Modal xác nhận xóa skill - bắt gõ DELETE (thay window.confirm)
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteSkill(name);
      router.push("/skills");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  return (
    // Full-width + editor cao hết viewport - tối đa diện tích soạn thảo.
    // 56px = thanh trên cùng của shell, 40px = padding dọc vùng nội dung. Hai
    // con số này hardcode vì chúng nằm trong Shell.tsx chứ không phải biến CSS;
    // đổi chiều cao shell thì phải sửa cả dòng này.
    <div className="flex h-[calc(100vh-56px-40px)] w-full flex-col gap-4">
      <PageHeader
        title={name}
        subtitle={t("skills.detail-subtitle")}
        actions={
          <>
            <Link href="/skills">
              <Button variant="secondary">
                <ArrowLeft size={15} strokeWidth={2} />
                {t("common.back-to-list")}
              </Button>
            </Link>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 size={15} strokeWidth={2} />
              {t("common.delete")}
            </Button>
            <Button onClick={onSave} disabled={!dirty || saving}>
              <Save size={15} strokeWidth={2} />
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </>
        }
      />

      {error && <ErrorBanner message={t("skills.action-error")} detail={error} />}
      {savedAt && !dirty && !error && (
        <Banner tone="success" message={t("common.saved")} />
      )}

      <Card className="flex min-h-0 flex-1 flex-col">
        {content != null ? (
          // text-sm chứ không phải 13px: đây là ô người dùng GÕ vào, thu nhỏ
          // đúng chỗ cần đọc kỹ nhất là tự làm khó mình
          <textarea
            className="input h-full min-h-0 w-full flex-1 resize-none font-mono text-sm leading-relaxed"
            value={content}
            spellCheck={false}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
          />
        ) : !error ? (
          <Skeleton className="min-h-0 w-full flex-1" />
        ) : null}
      </Card>

      {/* Modal xác nhận xóa skill - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={deleteOpen}
        title={t("skills.delete-title")}
        description={
          <>
            {t("skills.delete-desc-1")}{" "}
            <span className="font-medium">{name}</span>? {t("common.no-undo")}
          </>
        }
        busy={deleting}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />
    </div>
  );
}
