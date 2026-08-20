"use client";

import { BookOpen, Plus, SearchX, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createSkill, getSkills, type SkillMeta } from "@/lib/api";
import { Card } from "@/components/Card";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { CardGridSkeleton } from "@/components/Skeleton";
import { SkillGenerateModal } from "@/components/SkillGenerateModal";
import { Toolbar } from "@/components/Toolbar";
import { formatBytes, formatRelative, KEBAB_RE } from "@/lib/format";
import { useT } from "@/lib/i18n";

const skillTemplate = (name: string) => `---
name: ${name}
description: Mô tả ngắn gọn skill này làm gì và khi nào Claude nên dùng.
---

# ${name}

## Khi nào dùng

- ...

## Hướng dẫn

1. ...
`;

/** Lưới thẻ dùng CHUNG với trang Prompts - cùng một việc thì cùng một lưới.
    Lưới nằm TRONG <Card> cùng <Toolbar>; thẻ con là <Panel> vì Card → Panel là
    hết mức lồng cho phép. */
const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

export default function SkillsPage() {
  const { t, tf } = useT();
  const router = useRouter();
  const [skills, setSkills] = useState<SkillMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Modal "Tạo skill bằng AI" - remount mỗi lần mở (key) để form sạch
  const [aiOpen, setAiOpen] = useState(false);
  const [aiKey, setAiKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setSkills(await getSkills());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Lọc tại chỗ theo tên + mô tả - danh sách skill nằm sẵn trong bộ nhớ
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !skills) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }, [skills, query]);

  const nameValid = KEBAB_RE.test(name);

  async function onCreate() {
    if (!nameValid || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createSkill({ name, content: skillTemplate(name) });
      setOpen(false);
      setName("");
      router.push(`/skills/${name}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.skills")}
        hint={{ titleKey: "help.skills.title", bodyKey: "help.skills.body" }}
        subtitle={t("skills.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(true)}>
              <Plus size={16} strokeWidth={2} />
              {t("skills.create")}
            </Button>
            <Button
              onClick={() => {
                setAiKey((k) => k + 1);
                setAiOpen(true);
              }}
            >
              <Sparkles size={16} strokeWidth={2} />
              {t("skills.create-ai")}
            </Button>
          </>
        }
      />

      {/* Skill sửa xong chỉ có hiệu lực ở PHIÊN SAU - đây là điều dễ làm người
          dùng tưởng hệ thống hỏng, nên nói bằng banner chứ không phải chú thích mờ */}
      <Banner tone="muted" message={t("skills.next-session-note")} />

      {error && <ErrorBanner message={t("skills.load-error")} detail={error} />}

      <Card title={tf("skills.count", { n: skills?.length ?? 0 })}>
        <Toolbar
          search={{
            value: query,
            onChange: setQuery,
            placeholder: t("skills.search"),
          }}
        />

        {/* Khung chờ CHỈ hiện khi đang tải thật. Tải hỏng thì chỉ còn banner đỏ
            ở trên: để khung chờ chạy tiếp là vừa báo "đang tải" vừa báo "tải lỗi"
            cùng lúc, mà cho danh sách về rỗng thì lại nói dối là "chưa có gì". */}
        {skills === null ? (
          !error && (
            <div className={GRID}>
              <CardGridSkeleton count={8} />
            </div>
          )
        ) : filtered && filtered.length > 0 ? (
          <div className={GRID}>
            {filtered.map((s) => (
              <Link key={s.name} href={`/skills/${s.name}`}>
                <Panel className="h-full transition-colors duration-150 hover:border-[var(--primary)]">
                  <div className="flex items-start gap-3">
                    <BookOpen
                      size={18}
                      strokeWidth={1.75}
                      className="mt-0.5 shrink-0 text-[var(--primary)]"
                    />
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{s.name}</h3>
                      <p className="mt-1 line-clamp-3 text-sm text-[var(--text-muted)]">
                        {s.description}
                      </p>
                      <p className="mt-2 text-meta text-[var(--text-muted)]">
                        {formatRelative(s.updatedAt)} · {formatBytes(s.sizeBytes)}
                      </p>
                    </div>
                  </div>
                </Panel>
              </Link>
            ))}
          </div>
        ) : skills.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            description={t("skills.empty")}
            action={
              <Button onClick={() => setOpen(true)}>
                <Plus size={16} strokeWidth={2} />
                {t("skills.create")}
              </Button>
            }
          />
        ) : (
          <EmptyState icon={SearchX} description={t("common.no-match")} />
        )}
      </Card>

      <Modal
        title={t("skills.create")}
        open={open}
        onClose={() => {
          // Đang tạo thì không cho đóng - modal đóng rồi vẫn navigate sau đó
          if (!creating) setOpen(false);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                if (!creating) setOpen(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={onCreate} disabled={!nameValid || creating}>
              {creating ? t("common.creating") : t("skills.create-short")}
            </Button>
          </>
        }
      >
        {createError && <ErrorBanner message={createError} />}
        <Field
          label={t("skills.name-label")}
          htmlFor="skill-name"
          error={name && !nameValid ? t("skills.kebab-error") : null}
          hint={t("skills.template-note")}
        >
          <input
            id="skill-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="vd: tiktok-hook-mo-dau"
          />
        </Field>
      </Modal>

      <SkillGenerateModal
        key={aiKey}
        open={aiOpen}
        skills={skills ?? []}
        onClose={() => setAiOpen(false)}
        onSaved={(skillName) => {
          setAiOpen(false);
          load();
          router.push(`/skills/${skillName}`);
        }}
      />
    </div>
  );
}
