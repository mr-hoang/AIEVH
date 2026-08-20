"use client";

import { Film, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  createOmniVideo,
  getOmniVideos,
  type OmniAspect,
  type OmniVideoItem,
  type OmniVideoTask,
} from "@/lib/api";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { formatBytes, formatDateTime } from "@/lib/format";

const TASKS: Array<{ value: OmniVideoTask; label: string }> = [
  { value: "text_to_video", label: "Tạo video từ mô tả" },
  { value: "image_to_video", label: "Làm ảnh chuyển động" },
  { value: "reference_to_video", label: "Tạo theo ảnh tham chiếu" },
  { value: "edit", label: "Chỉnh sửa video có sẵn" },
];

export default function OmniVideoPage() {
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState<OmniVideoTask>("text_to_video");
  const [aspect, setAspect] = useState<OmniAspect>("16:9");
  const [source, setSource] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<OmniVideoItem[] | null>(null);
  const [latest, setLatest] = useState<OmniVideoItem | null>(null);
  const [previousInteractionId, setPreviousInteractionId] = useState<string | null>(null);

  const load = useCallback(() => {
    getOmniVideos()
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => load(), [load]);

  async function generate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createOmniVideo({
        prompt: prompt.trim(),
        task,
        aspect,
        source,
        previousInteractionId,
      });
      setLatest(result);
      setPreviousInteractionId(result.interactionId ?? null);
      setPrompt("");
      setSource(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function newConversation() {
    setPreviousInteractionId(null);
    setLatest(null);
    setPrompt("");
    setSource(null);
    setTask("text_to_video");
  }

  const sourceRequired = task !== "text_to_video" && !previousInteractionId;
  const canGenerate = prompt.trim().length > 0 && (!sourceRequired || source !== null);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Gemini Omni Video"
        subtitle="Tạo cảnh AI, làm ảnh chuyển động hoặc chỉnh video bằng hội thoại; MP4 được lưu local trong outputs/."
        actions={
          <Button variant="secondary" onClick={newConversation} disabled={busy}>
            <RotateCcw size={15} strokeWidth={2} />
            Phiên mới
          </Button>
        }
      />

      {error && <ErrorBanner message="Không tạo được video" detail={error} />}
      {previousInteractionId && (
        <Banner
          tone="info"
          message="Đang tiếp tục cùng một phiên Omni. Prompt tiếp theo sẽ chỉnh bản video vừa tạo mà không phải tải lại."
        />
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
        <Card title="Yêu cầu tạo/chỉnh video">
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Công việc" htmlFor="omni-task">
                <select
                  id="omni-task"
                  className="input"
                  value={task}
                  disabled={busy || Boolean(previousInteractionId)}
                  onChange={(e) => setTask(e.target.value as OmniVideoTask)}
                >
                  {TASKS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Tỷ lệ" htmlFor="omni-aspect">
                <select
                  id="omni-aspect"
                  className="input"
                  value={aspect}
                  disabled={busy}
                  onChange={(e) => setAspect(e.target.value as OmniAspect)}
                >
                  <option value="16:9">16:9 - ngang</option>
                  <option value="9:16">9:16 - dọc</option>
                </select>
              </Field>
            </div>

            {!previousInteractionId && task !== "text_to_video" && (
              <Field
                label={task === "edit" ? "Video nguồn" : "Ảnh tham chiếu"}
                htmlFor="omni-source"
                hint={task === "edit" ? "Video tối đa 250MB; file Gemini tạm được xóa sau lượt xử lý." : "Ảnh tối đa 25MB; chỉ gửi tới Gemini cho lượt tạo này."}
              >
                <input
                  id="omni-source"
                  className="input"
                  type="file"
                  accept={task === "edit" ? "video/*" : "image/*"}
                  disabled={busy}
                  onChange={(e) => setSource(e.target.files?.[0] ?? null)}
                />
              </Field>
            )}

            <Field
              label={previousInteractionId ? "Yêu cầu chỉnh tiếp" : "Mô tả cảnh và chuyển động"}
              htmlFor="omni-prompt"
              hint="Nêu rõ chủ thể, hành động, chuyển động camera, ánh sáng và âm thanh mong muốn."
            >
              <textarea
                id="omni-prompt"
                className="input min-h-36 resize-y"
                value={prompt}
                disabled={busy}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ví dụ: Máy quay dolly chậm tiến về sản phẩm, ánh sáng studio ấm, nền tối, chuyển động tự nhiên, không chèn chữ..."
              />
            </Field>

            <div className="flex justify-end">
              <Button onClick={generate} disabled={!canGenerate || busy}>
                {busy ? (
                  <Loader2 size={15} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Sparkles size={15} strokeWidth={2} />
                )}
                {busy ? "Gemini đang xử lý…" : previousInteractionId ? "Chỉnh video" : "Tạo video"}
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Bản mới nhất">
          {latest ? (
            <div className="flex flex-col gap-3">
              <video
                className="max-h-[520px] w-full rounded-[var(--radius)] bg-black"
                src={latest.mediaUrl}
                controls
                playsInline
              />
              <div className="flex flex-wrap gap-2">
                <a className="btn btn-secondary" href={latest.mediaUrl} download={latest.file}>
                  Tải MP4
                </a>
                <Button variant="secondary" onClick={() => setTask("edit")}>
                  Chỉnh tiếp bằng hội thoại
                </Button>
              </div>
            </div>
          ) : (
            <EmptyState icon={Film} description="Video vừa tạo sẽ xuất hiện tại đây." />
          )}
        </Card>
      </div>

      <Card title="Video Omni đã lưu trên máy">
        {items && items.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                <video className="aspect-video w-full rounded-[var(--radius)] bg-black" src={item.mediaUrl} controls preload="metadata" />
                <p className="mt-2 truncate text-sm font-medium" title={item.file}>{item.file}</p>
                <p className="text-meta text-[var(--text-muted)]">
                  {item.size ? formatBytes(item.size) : ""}
                  {item.createdAt ? ` · ${formatDateTime(item.createdAt)}` : ""}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Film} description="Chưa có video Gemini Omni nào." />
        )}
      </Card>
    </div>
  );
}
