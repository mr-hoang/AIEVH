"use client";

import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  Clapperboard,
  Coins,
  Film,
  ListVideo,
  MessagesSquare,
  Play,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getChatSessions,
  getJobs,
  getOverview,
  getProjects,
  getUsageByModel,
  getUsageTimeline,
  type ChatSession,
  type Job,
  type Overview,
  type ProjectSummary,
  type UsageByModel,
  type UsageScope,
  type UsageTimelinePoint,
} from "@/lib/api";
import { useAgentEvents, useEvents, useJobEvents } from "@/lib/useEvents";
import { Banner } from "@/components/Banner";
import { Card } from "@/components/Card";
import { Badge, ProjectBadge } from "@/components/Badge";
import { ProgressBar } from "@/components/ProgressBar";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/Button";
import { Segmented } from "@/components/Segmented";
import { Skeleton, TableSkeleton } from "@/components/Skeleton";
import { StatTile } from "@/components/StatTile";
import { SessionStatusBadge } from "@/components/SessionStatusBadge";
import { TokenTimelineChart } from "@/components/TokenTimelineChart";
import { formatRelative, formatTokens, formatUsd } from "@/lib/format";
import { useT } from "@/lib/i18n";

// Giá trị là KEY dictionary - dịch bằng t() lúc render.
const JOB_TYPE_LABEL: Record<Job["type"], string> = {
  "scene-draft": "dash.job.scene-draft",
  "scene-final": "dash.job.scene-final",
  "assemble-draft": "dash.job.assemble-draft",
  "assemble-final": "dash.job.assemble-final",
  "image-gen": "dash.job.image-gen",
  "auto-cut": "dash.job.auto-cut",
  "auto-trim": "dash.job.auto-trim",
  "project-transcript": "dash.job.project-transcript",
  "text-to-video": "dash.job.text-to-video",
  "translate-video": "dash.job.translate-video",
};

function healthProblems(
  overview: Overview,
  t: (key: string) => string
): string[] {
  const problems: string[] = [];
  const c = overview.health?.checks;
  if (!c) return problems;
  if (!c.ffmpeg) problems.push(t("dash.health.ffmpeg"));
  if (!c.claudeAuth) problems.push(t("dash.health.claude"));
  if (!c.hyperframes) problems.push(t("dash.health.hyperframes"));
  return problems;
}

/** yyyy-mm-dd theo giờ địa phương - so "hôm nay" cho tile Job. */
function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Khung chờ của một stat tile - cao đúng bằng tile thật để hàng không nhảy. */
const TILE_SKELETON = "h-28 w-full";

const USAGE_DAYS_OPTIONS = [7, 30, 90] as const;

/**
 * Tên nhà cung cấp viết hoa đúng chuẩn thương hiệu. KHÔNG phải chuỗi dịch: đây
 * là danh từ riêng, "OpenAI" viết hoa như vậy ở mọi ngôn ngữ. Provider lạ thì
 * lùi về viết hoa chữ đầu chứ không để trống.
 */
const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
};

const providerLabel = (p: string) =>
  PROVIDER_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

// label là KEY dictionary - dịch bằng t() lúc render.
const USAGE_SCOPE_OPTIONS: { value: UsageScope; label: string }[] = [
  { value: "all", label: "dash.scope.all" },
  { value: "video", label: "dash.scope.video" },
  { value: "image", label: "dash.scope.image" },
];

export default function DashboardPage() {
  const { t, tf } = useT();
  const { resyncTick } = useEvents();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overviewRef = useRef<Overview | null>(null);
  overviewRef.current = overview;

  // Card "Token AI theo ngày" - timeline theo bộ lọc ngày + loại project
  const [timeline, setTimeline] = useState<UsageTimelinePoint[] | null>(null);
  const [usageDays, setUsageDays] = useState<number>(30);
  const [usageScope, setUsageScope] = useState<UsageScope>("all");
  // Bảng "Chi phí AI theo model" - DÙNG CHUNG usageDays với chart phía trên để
  // hai khối luôn nói về cùng một khoảng thời gian (không có bộ lọc thứ hai).
  // Nhưng KHÔNG dùng usageScope: API /usage/by-model chưa nhận bộ lọc loại
  // project, nên bảng luôn là "mọi loại project". Chuyện đó được nói thẳng ra
  // ở dòng phạm vi trong actions của card - im lặng thì người dùng đổi bộ lọc
  // sang "Video" rồi đọc bảng ngay dưới như thể nó cũng đã lọc.
  const [byModel, setByModel] = useState<UsageByModel[] | null>(null);
  const [byModelError, setByModelError] = useState<string | null>(null);
  // Stat tile "Token 30 ngày" hàng trên - cố định 30 ngày, không theo filter
  const [timeline30, setTimeline30] = useState<UsageTimelinePoint[] | null>(
    null
  );
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await getOverview());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadJobs = useCallback(() => {
    getJobs(300)
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const loadSessions = useCallback(() => {
    getChatSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  // Fetch song song mọi nguồn dữ liệu lúc mở trang + refetch mỗi khi SSE
  // reconnect (resyncTick tăng) - trong lúc đứt kết nối, job/phiên AI có thể
  // đã kết thúc mà dashboard không nhận được event.
  useEffect(() => {
    loadOverview();
    loadJobs();
    loadSessions();
    getUsageTimeline(30)
      .then(setTimeline30)
      .catch(() => setTimeline30([]));
    getProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [loadOverview, loadJobs, loadSessions, resyncTick]);

  // Đổi bộ lọc (ngày / loại project) → refetch timeline của card
  useEffect(() => {
    let stale = false;
    setTimeline(null);
    getUsageTimeline(usageDays, usageScope)
      .then((data) => {
        if (!stale) setTimeline(data);
      })
      .catch(() => {
        if (!stale) setTimeline([]);
      });
    return () => {
      stale = true;
    };
  }, [usageDays, usageScope]);

  // Bảng theo model - chỉ phụ thuộc số ngày (API không có bộ lọc loại project)
  useEffect(() => {
    let stale = false;
    setByModel(null);
    setByModelError(null);
    getUsageByModel(usageDays)
      .then((data) => {
        if (!stale) setByModel(data);
      })
      .catch((e) => {
        // Giữ byModel = null: card hiện banner lỗi thay cho bảng, không hiện ô
        // "chưa có dữ liệu" - tải hỏng và thật sự chưa tiêu đồng nào là hai
        // chuyện khác hẳn nhau.
        if (!stale) setByModelError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      stale = true;
    };
  }, [usageDays]);

  // Realtime: cập nhật job đang chạy trực tiếp, refetch khi job đổi trạng thái.
  // Queue chạy tối đa 4 job song song → upsert vào runningJobs theo id,
  // không đè lẫn nhau qua một field duy nhất.
  useJobEvents((job) => {
    const prev = overviewRef.current;
    if (!prev) {
      // Event tới trước khi overview load xong - refetch thay vì nuốt event
      loadOverview();
      loadJobs();
      return;
    }
    if (job.status === "running") {
      setOverview((cur) => {
        if (!cur) return cur;
        const list = cur.runningJobs ?? (cur.runningJob ? [cur.runningJob] : []);
        const idx = list.findIndex((j) => j.id === job.id);
        const runningJobs =
          idx === -1
            ? [...list, job]
            : list.map((j) => (j.id === job.id ? job : j));
        return {
          ...cur,
          runningJobs,
          // Giữ runningJob đồng bộ cho phần code còn dựa vào field cũ
          runningJob:
            cur.runningJob && cur.runningJob.id !== job.id
              ? cur.runningJob
              : job,
        };
      });
    } else {
      // queued / done / failed / canceled - gỡ khỏi danh sách ngay cho đỡ
      // khựng, rồi làm mới overview + số liệu job/project
      setOverview((cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          runningJobs: (cur.runningJobs ?? []).filter((j) => j.id !== job.id),
          runningJob: cur.runningJob?.id === job.id ? null : cur.runningJob,
        };
      });
      loadOverview();
      loadJobs();
      getProjects()
        .then(setProjects)
        .catch(() => {});
    }
  });

  // Hoạt động của AI - theo TỪNG session (nhiều phiên chạy song song không đè nhau)
  const [agentActivities, setAgentActivities] = useState<
    Record<string, { steps: number; action: string }>
  >({});
  // Map sessionId → projectId để link "Mở project" trỏ đúng trang
  const sessionProjectRef = useRef<Record<string, string | null>>({});
  const [, setSessionMapVersion] = useState(0); // re-render khi map project về
  const fetchingSessionsRef = useRef(false);
  useAgentEvents((e) => {
    if (e.kind === "done" || e.kind === "error") {
      // Chỉ gỡ đúng phiên vừa kết thúc - các phiên khác vẫn hiển thị
      setAgentActivities((m) => {
        if (!(e.sessionId in m)) return m;
        const next = { ...m };
        delete next[e.sessionId];
        return next;
      });
      loadSessions(); // phiên vừa kết thúc - làm mới "Phiên AI gần đây"
      return;
    }
    setAgentActivities((m) => {
      const cur = m[e.sessionId] ?? { steps: 0, action: "" };
      return {
        ...m,
        [e.sessionId]: {
          steps: cur.steps + (e.kind === "tool" ? 1 : 0),
          action:
            e.kind === "tool"
              ? tf("dash.using-tool", {
                  tool: e.tool?.name ?? t("dash.tool-fallback"),
                })
              : t("dash.composing"),
        },
      };
    });
    if (
      sessionProjectRef.current[e.sessionId] === undefined &&
      !fetchingSessionsRef.current
    ) {
      fetchingSessionsRef.current = true;
      getChatSessions()
        .then((list) => {
          setSessions(list);
          for (const s of list) {
            sessionProjectRef.current[s.sessionId] = s.projectId;
          }
          setSessionMapVersion((v) => v + 1);
        })
        .catch(() => {
          // không tra được project - ẩn link, vẫn hiện trạng thái
        })
        .finally(() => {
          fetchingSessionsRef.current = false;
        });
    }
  });
  const agentEntries = Object.entries(agentActivities);

  // ===== Số liệu dẫn xuất =====
  // Tổng theo bộ lọc của card chart
  const usageTotal = (timeline ?? []).reduce(
    (acc, d) => ({
      tokens: acc.tokens + d.tokens,
      tokensIn: acc.tokensIn + (d.tokensIn ?? 0),
      tokensOut: acc.tokensOut + (d.tokensOut ?? 0),
      costUsd: acc.costUsd + d.costUsd,
    }),
    { tokens: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }
  );

  // Tổng 30 ngày cố định - stat tile hàng trên
  const usage30Total = (timeline30 ?? []).reduce(
    (acc, d) => ({
      tokens: acc.tokens + d.tokens,
      costUsd: acc.costUsd + d.costUsd,
    }),
    { tokens: 0, costUsd: 0 }
  );

  // Hàng TỔNG của bảng theo model.
  //
  // Từ khi server phân bổ tiền THẬT theo tỉ lệ giá (xem routes/usage.ts), mỗi
  // dòng đã có $vào + $ra = Tổng $. Nên hàng tổng cũng cộng đúng - trừ đúng
  // phần của những dòng KHÔNG biết đơn giá: chúng không chia được nên chỉ góp
  // vào cột tổng. Số tiền đó không được phép biến mất khỏi màn hình, nên tính
  // riêng thành `unallocatedUsd` và nói thẳng ra dưới bảng.
  const byModelTotal = (byModel ?? []).reduce(
    (acc, r) => ({
      tokensIn: acc.tokensIn + r.tokensIn,
      tokensOut: acc.tokensOut + r.tokensOut,
      costUsd: acc.costUsd + r.costUsd,
      costInUsd: acc.costInUsd + (r.costInUsd ?? 0),
      costOutUsd: acc.costOutUsd + (r.costOutUsd ?? 0),
      unallocatedUsd: acc.unallocatedUsd + (r.price === null ? r.costUsd : 0),
      unpricedRows: acc.unpricedRows + (r.price === null ? 1 : 0),
    }),
    {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      costInUsd: 0,
      costOutUsd: 0,
      unallocatedUsd: 0,
      unpricedRows: 0,
    }
  );

  const doneProjects = (projects ?? []).filter((p) => p.status === "done").length;
  const exportedProjects = (projects ?? []).filter((p) => p.output).length;

  const todayKey = localDayKey(new Date());
  const todayJobs = (jobs ?? []).filter(
    (j) => localDayKey(new Date(j.createdAt)) === todayKey
  );
  const todayDone = todayJobs.filter((j) => j.status === "done").length;
  const todayFailed = todayJobs.filter((j) => j.status === "failed");

  // Job lỗi hôm nay - trước đây chỉ là một con số lẫn trong dòng phụ của tile,
  // tức là thứ đáng xử lý nhất trên trang lại khó thấy nhất.
  const failedRecent = [...todayFailed]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .slice(0, 3);

  const projectName = (id: string) =>
    projects?.find((p) => p.id === id)?.name ?? id;

  const recentSessions = [...(sessions ?? [])]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .slice(0, 5);

  const problems = overview ? healthProblems(overview, t) : [];
  // Danh sách job đang chạy - fallback về runningJob khi server cũ chưa trả runningJobs
  const runningList =
    overview?.runningJobs ??
    (overview?.runningJob ? [overview.runningJob] : []);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.dashboard")}
        hint={{ titleKey: "help.dashboard.title", bodyKey: "help.dashboard.body" }}
        subtitle={t("dash.subtitle")}
      />

      {error && (
        <ErrorBanner message={t("dash.load-error")} detail={error} />
      )}
      {problems.length > 0 && (
        <ErrorBanner
          message={t("dash.health-title")}
          detail={problems.join("\n")}
        />
      )}

      {/* Job lỗi gần đây - có tên project + loại job + lúc nào, và đường đi
          thẳng sang hàng chờ để xem log. */}
      {failedRecent.length > 0 && (
        <Banner
          tone="danger"
          message={tf("dash.failed-today", { n: todayFailed.length })}
          actions={
            <Link href="/queue">
              <Button variant="secondary" small>
                <ListVideo size={14} strokeWidth={2} />
                {t("dash.view-queue")}
              </Button>
            </Link>
          }
        >
          <ul className="mt-1 flex flex-col gap-1">
            {failedRecent.map((j) => (
              <li key={j.id} className="text-meta text-[var(--text-muted)]">
                {projectName(j.projectId)} · {t(JOB_TYPE_LABEL[j.type])} ·{" "}
                {formatRelative(j.createdAt)}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {/* Hàng 1 - 5 stat tile. Số liệu cùng loại thì cùng hình dạng: "hàng chờ"
          trước đây là một card riêng ở hàng khác với cỡ chữ khác. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        {projects === null ? (
          <Skeleton className={TILE_SKELETON} />
        ) : (
          <StatTile
            icon={Clapperboard}
            value={String(projects.length)}
            label={t("dash.total-projects")}
            sub={tf("dash.done-count", { n: doneProjects })}
            href="/projects"
          />
        )}
        {projects === null ? (
          <Skeleton className={TILE_SKELETON} />
        ) : (
          <StatTile
            icon={Film}
            value={String(exportedProjects)}
            label={t("dash.exported")}
            sub={t("dash.has-output")}
            href="/projects"
          />
        )}
        {timeline30 === null ? (
          <Skeleton className={TILE_SKELETON} />
        ) : (
          <StatTile
            icon={BarChart3}
            value={formatTokens(usage30Total.tokens)}
            label={t("dash.tokens-30d")}
            sub={formatUsd(usage30Total.costUsd)}
            // CỐ Ý không có href: chưa có trang xem chi tiết mức dùng token.
            // /chat là stub redirect về "/" nên trỏ vào đó là bấm xong quay lại
            // đúng trang đang đứng - tệ hơn hẳn một ô không bấm được.
          />
        )}
        {jobs === null ? (
          <Skeleton className={TILE_SKELETON} />
        ) : (
          <StatTile
            icon={Activity}
            value={String(todayJobs.length)}
            label={t("dash.jobs-today")}
            sub={tf("dash.jobs-today-sub", {
              done: todayDone,
              failed: todayFailed.length,
            })}
            href="/queue"
          />
        )}
        {/* Tải hỏng thì không để ô này nhấp nháy mãi (banner đỏ ở trên đã nói
            rồi) - nhưng cũng KHÔNG bỏ trống ô: `!error && <Skeleton/>` render ra
            `false`, và lưới 5 cột mất hẳn ô thứ 5, thành một hàng thủng lỗ. Vẫn
            dựng ô với giá trị "-" để hàng còn nguyên hình. */}
        {overview === null ? (
          error ? (
            <StatTile
              icon={ListVideo}
              value="-"
              label={t("dash.queue")}
              sub={t("dash.jobs-waiting")}
            />
          ) : (
            <Skeleton className={TILE_SKELETON} />
          )
        ) : (
          <StatTile
            icon={ListVideo}
            value={String(overview.queuedCount)}
            label={t("dash.queue")}
            sub={t("dash.jobs-waiting")}
            href="/queue"
          />
        )}
      </div>

      {/* Hàng 2 - chart 2/3 + cột phải (AI / job đang chạy).
          KHÔNG items-start: cột phải phải cao bằng chart, nếu không thì mỗi khi
          không có phiên AI (trường hợp thường gặp) đáy cột phải hụt một lỗ. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title={t("dash.tokens-by-day")}
          className="lg:col-span-2"
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Segmented
                // md: đứng cùng hàng với <select> cao 36px ngay bên cạnh
                size="md"
                label={t("dash.days-aria")}
                value={String(usageDays)}
                onChange={(v) => setUsageDays(Number(v))}
                options={USAGE_DAYS_OPTIONS.map((d) => ({
                  value: String(d),
                  label: tf("dash.days", { n: d }),
                }))}
              />
              <select
                className="input w-auto"
                aria-label={t("dash.scope-aria")}
                value={usageScope}
                onChange={(e) => setUsageScope(e.target.value as UsageScope)}
              >
                {USAGE_SCOPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </select>
            </div>
          }
        >
          {/* Câu tổng nằm DƯỚI tiêu đề chứ không nhét vào hàng nút: nhồi bốn
              nhóm điều khiển cao thấp khác nhau lên một hàng là thứ làm header
              card này rối nhất. */}
          {timeline && usageTotal.tokens > 0 && (
            <p
              className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-[var(--text-muted)]"
              title={`${usageTotal.tokens.toLocaleString("vi-VN")} token`}
            >
              <span>
                {tf("dash.total-days", {
                  days: usageDays,
                  tokens: formatTokens(usageTotal.tokens),
                  cost: formatUsd(usageTotal.costUsd),
                })}
              </span>
              <span className="inline-flex items-center gap-1">
                <ArrowDownToLine
                  size={13}
                  strokeWidth={2}
                  className="shrink-0"
                  aria-hidden
                />
                {formatTokens(usageTotal.tokensIn)} in
                <span aria-hidden>·</span>
                <ArrowUpFromLine
                  size={13}
                  strokeWidth={2}
                  className="shrink-0"
                  aria-hidden
                />
                {formatTokens(usageTotal.tokensOut)} out
              </span>
            </p>
          )}

          {timeline === null ? (
            <Skeleton className="w-full" height={220} />
          ) : usageTotal.tokens > 0 ? (
            <TokenTimelineChart data={timeline} days={usageDays} />
          ) : (
            <EmptyState
              icon={BarChart3}
              description={t("dash.no-usage")}
            />
          )}
        </Card>

        <div className="flex flex-col gap-4">
          {agentEntries.length > 0 && (
            <Card
              title={
                agentEntries.length === 1
                  ? t("dash.ai-working")
                  : tf("dash.ai-working-n", { n: agentEntries.length })
              }
              actions={<SessionStatusBadge status="running" />}
            >
              <div className="flex flex-col gap-3">
                <div className="progress-indeterminate" />
                {agentEntries.map(([sid, act]) => {
                  const pid = sessionProjectRef.current[sid] ?? null;
                  return (
                    <div
                      key={sid}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Sparkles
                          size={14}
                          strokeWidth={2}
                          className="shrink-0 text-[var(--primary)]"
                        />
                        <span className="truncate text-[var(--text-muted)]">
                          {act.action}
                          {act.steps > 0 &&
                            ` · ${tf("dash.step", { n: act.steps })}`}
                        </span>
                      </span>
                      {pid && (
                        <Link
                          href={`/projects/${encodeURIComponent(pid)}`}
                          className="shrink-0 text-sm font-medium text-[var(--primary)] hover:underline"
                        >
                          {t("dash.open-project")}
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* flex-1: card cuối cột giãn hết chiều cao còn lại của hàng - không
              còn khoảng trắng lửng lơ dưới cột phải. */}
          <Card
            className="flex-1"
            title={
              runningList.length > 1
                ? tf("dash.running-job-n", { n: runningList.length })
                : t("dash.running-job")
            }
          >
            {runningList.length > 0 ? (
              <div className="flex flex-col">
                {runningList.map((job, i) => (
                  <div
                    key={job.id}
                    className={`flex flex-col gap-2 py-2 first:pt-0 last:pb-0 ${
                      i < runningList.length - 1
                        ? "border-b border-[var(--border)]"
                        : ""
                    }`}
                  >
                    <div className="flex min-w-0 items-baseline justify-between gap-2">
                      <Link
                        href={
                          // auto-cut/text-to-video: projectId là id phiên của
                          // trang riêng, không phải project video - link theo loại
                          job.type === "auto-cut"
                            ? `/auto-cut/${job.projectId}`
                            : job.type === "text-to-video"
                              ? `/text-to-video/${job.projectId}`
                              : `/projects/${job.projectId}`
                        }
                        className="truncate text-sm font-medium hover:text-[var(--primary)]"
                      >
                        {/* Hiện TÊN project chứ không phải id: id là tên thư mục,
                            đổi tên project xong mà đây vẫn hiện "demo111" thì đổi
                            tên chẳng giải quyết được gì. Job của auto-cut và
                            text-to-video mang id PHIÊN nên không có trong danh
                            sách project - khi đó lùi về hiện id như cũ. */}
                        {projectName(job.projectId)}
                      </Link>
                      <span className="shrink-0 text-meta text-[var(--text-muted)]">
                        {t(JOB_TYPE_LABEL[job.type])}
                        {job.sceneId ? ` · ${job.sceneId}` : ""}
                      </span>
                    </div>
                    <ProgressBar progress={job.progress} step={job.step} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon={Play} description={t("dash.no-running-job")} />
            )}
          </Card>
        </div>
      </div>

      {/* Chi phí AI theo model - nằm NGAY DƯỚI chart token vì cùng nói về một
          thứ: tiền AI. Dùng chung bộ lọc số ngày với chart, không có bộ lọc
          riêng - hai khối lệch khoảng thời gian thì người đọc sẽ cộng trừ hai
          con số không so được với nhau.
          Bộ lọc LOẠI PROJECT thì bảng này không theo được (API chưa nhận), nên
          phạm vi được ghi thẳng ra: "N ngày · mọi loại project". */}
      <Card
        title={t("dash.cost-by-model")}
        hint={{
          titleKey: "help.cost-by-model.title",
          bodyKey: "help.cost-by-model.body",
        }}
        actions={
          <span className="text-meta text-[var(--text-muted)]">
            {tf("dash.cost-by-model-scope", { n: usageDays })}
          </span>
        }
      >
        {byModelError ? (
          <ErrorBanner
            message={t("dash.cost-by-model-error")}
            detail={byModelError}
          />
        ) : byModel === null ? (
          <TableSkeleton rows={4} />
        ) : byModel.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t("dash.col-ai")}</th>
                <th>{t("dash.col-model")}</th>
                <th className="text-right">{t("dash.col-tokens-in")}</th>
                <th className="text-right">{t("dash.col-tokens-out")}</th>
                <th className="text-right">{t("dash.col-cost-in")}</th>
                <th className="text-right">{t("dash.col-cost-out")}</th>
                <th className="text-right">{t("dash.col-cost-total")}</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((r) => (
                <tr key={`${r.provider}:${r.model ?? ""}`}>
                  <td>
                    {/* dot={false}: đây là nhãn PHÂN LOẠI, chấm tròn là quy ước
                        của trạng thái - gắn vào đây đọc thành "đang chạy". */}
                    <Badge
                      tone="muted"
                      dot={false}
                      label={providerLabel(r.provider)}
                    />
                  </td>
                  <td className="text-sm">
                    {r.model ?? (
                      <span className="text-[var(--text-muted)]">
                        {t("dash.model-none")}
                      </span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatTokens(r.tokensIn)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatTokens(r.tokensOut)}
                  </td>
                  <td className="text-right tabular-nums">
                    {r.costInUsd === null ? (
                      <span className="text-[var(--text-muted)]">-</span>
                    ) : (
                      formatUsd(r.costInUsd)
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {r.costOutUsd === null ? (
                      <span className="text-[var(--text-muted)]">-</span>
                    ) : (
                      formatUsd(r.costOutUsd)
                    )}
                  </td>
                  <td className="text-right tabular-nums font-medium">
                    {formatUsd(r.costUsd)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-[var(--border)] font-semibold">
                <td colSpan={2}>{t("dash.total-row")}</td>
                <td className="text-right tabular-nums">
                  {formatTokens(byModelTotal.tokensIn)}
                </td>
                <td className="text-right tabular-nums">
                  {formatTokens(byModelTotal.tokensOut)}
                </td>
                <td className="text-right tabular-nums">
                  {formatUsd(byModelTotal.costInUsd)}
                </td>
                <td className="text-right tabular-nums">
                  {formatUsd(byModelTotal.costOutUsd)}
                </td>
                <td className="text-right tabular-nums">
                  {formatUsd(byModelTotal.costUsd)}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <EmptyState icon={Coins} description={t("dash.no-usage-by-model")} />
        )}

        {/* Chỉ còn MỘT chỗ duy nhất mà bảng không tự cộng khít: các dòng không
            biết đơn giá nên không chia được ra hai chiều. Nói rõ số tiền đó là
            bao nhiêu, để người đọc cộng tay vẫn ra đúng cột tổng. */}
        {byModel !== null &&
          byModel.length > 0 &&
          byModelTotal.unpricedRows > 0 && (
            <p className="mt-3 text-meta text-[var(--text-muted)]">
              {tf("dash.unallocated-note", {
                n: byModelTotal.unpricedRows,
                amount: formatUsd(byModelTotal.unallocatedUsd),
              })}
            </p>
          )}
      </Card>

      {/* Hàng 3 - project gần đây (bảng) + phiên AI gần đây */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title={t("dash.recent-projects")}
          actions={
            <Link
              href="/projects"
              className="text-sm font-medium text-[var(--primary)] hover:underline"
            >
              {t("dash.view-all")}
            </Link>
          }
        >
          {overview === null ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : overview.recentProjects.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("common.name")}</th>
                  <th>{t("common.status")}</th>
                  <th>{t("dash.col-token")}</th>
                  <th>{t("common.updated")}</th>
                </tr>
              </thead>
              <tbody>
                {overview.recentProjects.slice(0, 5).map((p) => (
                  <tr key={p.id}>
                    <td className="max-w-0 w-2/5">
                      <Link
                        href={`/projects/${p.id}`}
                        className="block truncate font-medium hover:text-[var(--primary)]"
                      >
                        {p.name}
                      </Link>
                    </td>
                    <td>
                      <ProjectBadge status={p.status} />
                    </td>
                    <td className="text-[var(--text-muted)]">
                      {(p.tokensUsed ?? 0) > 0 ? formatTokens(p.tokensUsed) : "-"}
                    </td>
                    <td className="whitespace-nowrap text-[var(--text-muted)]">
                      {formatRelative(p.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              icon={Clapperboard}
              description={t("projects.empty")}
              action={
                <Link href="/projects">
                  <Button>{t("projects.create")}</Button>
                </Link>
              }
            />
          )}
        </Card>

        <Card title={t("dash.recent-sessions")}>
          {sessions === null ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : recentSessions.length > 0 ? (
            <ul className="flex flex-col">
              {recentSessions.map((s, i) => (
                <li
                  key={s.sessionId}
                  className={`flex items-center gap-3 py-2 ${
                    i < recentSessions.length - 1
                      ? "border-b border-[var(--border)]"
                      : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {s.title || t("dash.chat-session")}
                  </span>
                  <SessionStatusBadge status={s.status} />
                  <span className="shrink-0 text-meta text-[var(--text-muted)]">
                    {formatRelative(s.updatedAt)}
                  </span>
                  {s.projectId && (
                    <Link
                      href={`/projects/${encodeURIComponent(s.projectId)}`}
                      className="shrink-0 text-sm font-medium text-[var(--primary)] hover:underline"
                    >
                      {t("dash.open-project")}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={MessagesSquare}
              description={t("dash.no-sessions")}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
