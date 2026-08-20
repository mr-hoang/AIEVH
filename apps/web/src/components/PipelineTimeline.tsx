"use client";

/**
 * Thanh timeline giai đoạn pipeline của một video project - stepper ngang
 * 6 giai đoạn, gọn để nằm cùng hàng header. Giai đoạn suy ra HOÀN TOÀN phía
 * client từ dữ liệu trang đã có (meta + jobs + session AI) - backend vẫn là
 * nguồn sự thật về job, component chỉ đọc.
 */

import { Check, Loader2 } from "lucide-react";
import type { FileInfo, Job, ProjectStatus, SceneMeta } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Giá trị là KEY dictionary - dịch bằng t() lúc render.
const STEPS = [
  "pipeline.analyze",
  "pipeline.build-scenes",
  "pipeline.render-draft",
  "pipeline.assemble-draft",
  "pipeline.render-final",
  "pipeline.done",
] as const;

export interface PipelineStageInput {
  metaStatus: ProjectStatus | undefined;
  hasOutput: boolean;
  scenes: SceneMeta[];
  renders: FileInfo[];
  /** Jobs của project này (mọi trạng thái) - cập nhật sống qua SSE. */
  jobs: Job[];
  /** Có phiên AI của project đang chạy. */
  sessionRunning: boolean;
}

/** Kết quả suy giai đoạn: stage 1-6 + active (đang có việc chạy → pulse). */
export interface PipelineStage {
  stage: number;
  active: boolean;
}

/** Mốc "đã qua" suy từ job done - nâng floor khi không có gì đang chạy rõ hơn. */
function doneJobFloor(jobs: Job[]): number {
  let floor = 0;
  for (const j of jobs) {
    if (j.status !== "done") continue;
    const f =
      j.type === "scene-draft"
        ? 3
        : j.type === "assemble-draft"
          ? 4
          : j.type === "scene-final" || j.type === "assemble-final"
            ? 5
            : 0;
    if (f > floor) floor = f;
  }
  return floor;
}

/**
 * Suy giai đoạn hiện tại của pipeline - thuần, không side effect.
 * Trả null = chưa bắt đầu gì (project draft trống) → ẩn timeline.
 */
export function deriveStage(input: PipelineStageInput): PipelineStage | null {
  const { metaStatus, hasOutput, scenes, renders, jobs, sessionRunning } =
    input;

  // 6 - final đã xuất, meta chốt done
  if (metaStatus === "done" && hasOutput) return { stage: 6, active: false };

  // Job đang chạy/chờ quyết định giai đoạn trực tiếp
  const activeTypes = new Set(
    jobs
      .filter((j) => j.status === "running" || j.status === "queued")
      .map((j) => j.type)
  );
  if (activeTypes.has("scene-final") || activeTypes.has("assemble-final"))
    return { stage: 5, active: true };
  if (activeTypes.has("assemble-draft")) return { stage: 4, active: true };
  if (activeTypes.has("scene-draft")) return { stage: 3, active: true };

  // Mốc suy từ sản phẩm đã có trên đĩa: có file draft render → 3, có scene → 2
  const hasDraftRender = renders.some((f) => f.kind === "video");
  const artifactFloor = hasDraftRender ? 3 : scenes.length > 0 ? 2 : 0;
  const floor = Math.max(artifactFloor, doneJobFloor(jobs));

  if (sessionRunning) {
    // AI đang chạy nhưng chưa có job render nào - đang phân tích/dựng scene
    return { stage: Math.max(floor, 1), active: true };
  }

  // Không gì chạy, chưa done: giữ mốc cao nhất đã đạt; chưa có gì → ẩn
  if (floor === 0) return null;
  return { stage: floor, active: false };
}

/**
 * Thanh stepper thuần hình - KHÔNG biết gì về video project.
 *
 * Tách ra để Text to video dùng đúng thanh này thay vì tự vẽ thanh thứ hai:
 * hai thanh trông na ná nhau là kiểu lệch giao diện khó thấy nhất, vì mỗi lần
 * chỉnh một bên thì bên kia lặng lẽ trôi đi.
 *
 * @param steps  KEY dictionary của từng bước (dịch bằng t() lúc render)
 * @param stage  bước hiện tại, đếm từ 1
 * @param active có việc đang chạy ở bước đó không (chấm nhấp nháy)
 * @param done   đã xong hết (bước cuối hiện tick thay vì chấm)
 * @param marker hình đánh dấu bước ĐANG chạy: "dot" (chấm primary nhấp nháy,
 *               mặc định - hợp với timeline nằm cùng hàng header) hoặc
 *               "spinner" (vòng xoay, hợp với modal có một việc dài đang chạy)
 * @param wrapLabels cho nhãn bước xuống dòng thay vì giữ một dòng - dùng khi
 *               thanh nằm trong khung hẹp cố định (modal) chứ không phải header
 */
export function StepperBar({
  steps,
  stage,
  active,
  done,
  marker = "dot",
  wrapLabels = false,
  ariaLabel,
}: {
  steps: readonly string[];
  stage: number;
  active: boolean;
  done: boolean;
  marker?: "dot" | "spinner";
  wrapLabels?: boolean;
  ariaLabel?: string;
}) {
  const { t } = useT();
  return (
    <ol className="flex w-full min-w-0 items-start" aria-label={ariaLabel}>
      {steps.flatMap((label, i) => {
        const n = i + 1;
        const passed = n < stage || (n === stage && done);
        const current = n === stage && !done;
        const labelCls = current
          ? "font-semibold text-[var(--text)]"
          : passed
            ? "text-[var(--text-muted)]"
            : "text-[var(--text-muted)] opacity-60";
        const items = [];
        if (i > 0) {
          // Connector là item riêng flex-1 → hút đúng phần dư, các bước shrink-0 không bao giờ tràn
          items.push(
            <li
              key={`c-${i}`}
              aria-hidden="true"
              className={`mx-1 mt-2 h-px min-w-2 flex-1 ${
                n <= stage ? "bg-[var(--success)]" : "bg-[var(--border)]"
              }`}
            />,
          );
        }
        items.push(
          <li
            key={label}
            className="flex shrink-0 flex-col items-center gap-1"
            aria-current={current ? "step" : undefined}
          >
            <span aria-hidden="true" className="flex h-4 items-center justify-center">
              {passed ? (
                <Check size={13} strokeWidth={3.5} className="text-[var(--success)]" />
              ) : current && marker === "spinner" ? (
                <Loader2
                  size={14}
                  strokeWidth={2.5}
                  className="animate-spin text-[var(--primary)]"
                />
              ) : current ? (
                <span
                  className={`h-2.5 w-2.5 rounded-full bg-[var(--primary)] ring-[3px] ring-[var(--primary-soft)]${
                    active ? " animate-pulse" : ""
                  }`}
                />
              ) : (
                <span className="h-2 w-2 rounded-full bg-[var(--border)]" />
              )}
            </span>
            <span
              className={`text-center text-xs leading-tight ${
                wrapLabels ? "" : "whitespace-nowrap"
              } ${labelCls}`}
            >
              {t(label)}
            </span>
          </li>,
        );
        return items;
      })}
    </ol>
  );
}

export function PipelineTimeline(props: PipelineStageInput) {
  const { t, tf } = useT();
  const derived = deriveStage(props);
  if (!derived) return null;
  const { stage, active } = derived;
  // Kéo giãn hết bề ngang container (connector flex-1); label dưới marker.
  // Giai đoạn XONG = tick ✓ xanh; đang chạy = chấm primary pulse; chưa tới = chấm mờ.
  const done = stage === 6 && !active;
  return (
    <StepperBar
      steps={STEPS}
      stage={stage}
      active={active}
      done={done}
      ariaLabel={tf("pipeline.aria", { stage, label: t(STEPS[stage - 1]) })}
    />
  );
}
