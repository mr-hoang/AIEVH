"use client";

/**
 * Trang Kết nối - quản lý API key của các AI provider (Claude, Gemini).
 * Key lưu qua PUT /api/connections/:provider/key, hiệu lực ngay không cần
 * restart. Sau khi đổi key gọi refreshProviders() để các select model/provider
 * nơi khác (ModelPicker) fetch lại danh sách mới.
 *
 * Ngôn ngữ biểu mẫu ĐI THEO trang Cấu hình (nhãn <Field>, nhịp hàng
 * divide-y + py-4): trước đây hai trang thiết lập này dùng hai bộ quy ước khác
 * nhau, kể cả bốn kiểu báo lỗi khác nhau.
 *
 * BÁO LỖI - đúng một chỗ, như trang Cấu hình: mọi lỗi TẢI và LƯU/HÀNH ĐỘNG
 * (lưu key, xóa key, lưu domain, bật/tắt tunnel, đọc trạng thái tunnel) đều đi
 * lên <ErrorBanner> cấp trang qua `onError(key, …)`. Các card không tự dựng
 * banner lỗi nữa - trước đây lỗi rơi vào năm bề mặt khác nhau (lỗi của <Field>,
 * hai <Banner> trong TunnelCard, banner cấp trang), nên cùng một loại sự cố
 * hiện ở đâu là tùy nó xảy ra lúc nào.
 *
 * Ba <Banner> còn nằm trong card đều KHÔNG phải lỗi hệ thống: kết quả bấm
 * "Kiểm tra kết nối" (người dùng chủ động hỏi thì trả lời ngay tại nút), câu
 * hướng dẫn cài cloudflared, và cảnh báo dashboard chưa có đăng nhập.
 */

import {
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Bot,
  Loader2,
  Mic,
  Pencil,
  Play,
  Plug,
  PlugZap,
  Sparkles,
  Square,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  getConnections,
  getTunnelStatus,
  openProviderLogin,
  setConnectionKey,
  setTunnelDomain,
  startTunnel,
  stopTunnel,
  testConnection,
  type ConnectionInfo,
  type TunnelStatus,
} from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { CopyButton } from "@/components/CopyButton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { Skeleton } from "@/components/Skeleton";
import { refreshProviders } from "@/components/ModelPicker";
import { useT } from "@/lib/i18n";

/**
 * Đẩy một lỗi lên banner cấp trang. `key` là nguồn lỗi (mỗi card một khóa
 * riêng) để lỗi của card này không xóa mất lỗi của card kia - TunnelCard poll
 * lại mỗi 4s, nếu dùng chung một ô lỗi thì nó chùi sạch lỗi lưu key vừa hiện.
 * Truyền `null` = nguồn đó hết lỗi.
 */
type ErrorReporter = (
  key: string,
  err: { message: string; detail?: string } | null
) => void;

/** Nhãn tiếng Việt cho role provider - khớp ProviderRole của server. */
// Giá trị là KEY dictionary - dịch bằng t() lúc render.
const ROLE_LABELS: Record<string, string> = {
  edit: "conn.role.edit",
  chat: "conn.role.chat",
  image: "conn.role.image",
  video: "conn.role.video",
  stt: "conn.role.stt",
};

const PROVIDER_ICONS: Record<ConnectionInfo["id"], LucideIcon> = {
  claude: Sparkles,
  gemini: ImageIcon,
  openai: Bot,
  soniox: Mic,
};

const KEY_PLACEHOLDERS: Record<ConnectionInfo["id"], string> = {
  claude: "sk-ant-...",
  gemini: "AIza...",
  openai: "sk-...",
  soniox: "Soniox API key",
};

/** Một hàng thiết lập - cùng nhịp dọc với trang Cấu hình. */
function Row({ children }: { children: React.ReactNode }) {
  return <div className="py-4 first:pt-0 last:pb-0">{children}</div>;
}

/** Icon vuông đứng trước tên card - dùng chung cho provider và tunnel. */
function CardIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] bg-[var(--bg-subtle)]">
      <Icon size={16} strokeWidth={1.75} className="text-[var(--primary)]" />
    </span>
  );
}

/** Dòng xác nhận ngắn (đã lưu / đã áp dụng) - cùng hình dạng với trang Cấu hình. */
function SavedNotice({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-meta font-medium text-[var(--success)]">
      <Check size={13} strokeWidth={2} className="shrink-0" />
      {children}
    </span>
  );
}

function StatusBadge({ conn }: { conn: ConnectionInfo }) {
  const { t } = useT();
  if (!conn.connected) {
    return <Badge tone="muted" label={t("model.not-connected")} />;
  }
  return (
    <Badge
      tone="success"
      label={
        conn.source === "oauth"
          ? t("conn.connected-sub")
          : t("conn.connected-key")
      }
    />
  );
}

function ProviderCard({
  conn,
  onUpdate,
  onError,
}: {
  conn: ConnectionInfo;
  onUpdate: (list: ConnectionInfo[]) => void;
  onError: ErrorReporter;
}) {
  const { t } = useT();
  const Icon = PROVIDER_ICONS[conn.id] ?? Plug;
  /** Khóa nguồn lỗi của riêng card này trên banner cấp trang. */
  const errKey = `key-${conn.id}`;

  // Khối API key
  const [editing, setEditing] = useState(false); // "Đổi key" đang mở input
  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);

  // Kiểm tra kết nối
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testConnection(conn.id));
    } catch (e) {
      setTestResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }, [conn.id]);

  async function onSaveKey() {
    const value = keyValue.trim();
    if (!value || saving) return;
    setSaving(true);
    onError(errKey, null);
    setSavedNotice(false);
    try {
      const res = await setConnectionKey(conn.id, value);
      onUpdate(res.connections);
      refreshProviders();
      setKeyValue("");
      setEditing(false);
      setShowKey(false);
      setSavedNotice(true);
      // Lưu xong tự kiểm tra luôn cho chắc
      runTest();
    } catch (e) {
      onError(errKey, {
        message: t("conn.save-key-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  // Modal xác nhận xóa API key - bắt gõ DELETE (thay window.confirm)
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function onDeleteKey() {
    if (saving) return;
    setSaving(true);
    onError(errKey, null);
    setSavedNotice(false);
    setTestResult(null);
    try {
      const res = await setConnectionKey(conn.id, null);
      onUpdate(res.connections);
      refreshProviders();
      setEditing(false);
      setKeyValue("");
      setShowKey(false);
    } catch (e) {
      onError(errKey, {
        message: t("conn.delete-key-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
      setDeleteOpen(false);
    }
  }

  const showInput = !conn.key.present || editing;
  const inputId = `conn-key-${conn.id}`;

  const getKeyLink = (
    <a
      href={conn.keyHelpUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm font-medium text-[var(--primary)] hover:underline"
    >
      {t("conn.get-key")}
      <ExternalLink size={12} strokeWidth={2} className="shrink-0" />
    </a>
  );

  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2">
          <CardIcon icon={Icon} />
          <span className="truncate">{conn.label}</span>
        </span>
      }
      actions={<StatusBadge conn={conn} />}
    >
      <div className="divide-y divide-[var(--border)]">
        <Row>
          <div className="flex flex-wrap gap-1">
            {conn.roles.map((r) => (
              <span key={r} className="chip">
                {ROLE_LABELS[r] ? t(ROLE_LABELS[r]) : r}
              </span>
            ))}
          </div>
          {conn.note && (
            <p className="mt-2 text-sm text-[var(--text-muted)]">{conn.note}</p>
          )}
        </Row>

        {conn.id !== "soniox" && (
          <Row>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Subscription <span className="text-[var(--success)]">(Khuyến nghị)</span></p>
                <p className="text-meta text-[var(--text-muted)]">Dùng tài khoản đã mua gói; key API là phương án dự phòng riêng.</p>
              </div>
              <Button
                variant="secondary"
                small
                disabled={loginBusy}
                onClick={async () => {
                  setLoginBusy(true);
                  setLoginMessage(null);
                  try {
                    const result = await openProviderLogin(conn.id);
                    setLoginMessage(result.message);
                  } catch (e) {
                    setLoginMessage(e instanceof Error ? e.message : String(e));
                  } finally {
                    setLoginBusy(false);
                  }
                }}
              >
                {loginBusy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Mở đăng nhập
              </Button>
            </div>
            {loginMessage && <p className="mt-2 text-meta text-[var(--text-muted)]">{loginMessage}</p>}
          </Row>
        )}

        <Row>
          <p className="mb-2 text-sm font-medium">API Key <span className="text-[var(--text-muted)]">(Dự phòng)</span></p>
          <Field
            label={`API key (${conn.key.envVar})`}
            htmlFor={showInput ? inputId : undefined}
            hintKeys={{
              titleKey: "help.connections-key.title",
              bodyKey: "help.connections-key.body",
            }}
          >
            {showInput ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[220px] flex-1">
                  <input
                    id={inputId}
                    className="input pr-9"
                    type={showKey ? "text" : "password"}
                    value={keyValue}
                    placeholder={KEY_PLACEHOLDERS[conn.id] ?? "API key"}
                    autoComplete="off"
                    spellCheck={false}
                    /* KHÔNG aria-label: ô này giờ đã có <label for> thật từ
                       <Field>. Đặt thêm aria-label là nó GIÀNH quyền đặt tên, khiến
                       chính dòng chữ đang hiện trên màn hình không bao giờ được đọc
                       lên (WCAG 2.5.3 - tên phải chứa nhãn nhìn thấy). */
                    disabled={saving}
                    onChange={(e) => setKeyValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSaveKey();
                    }}
                  />
                  <IconButton
                    label={showKey ? t("conn.hide-key") : t("conn.show-key")}
                    size="sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? (
                      <EyeOff size={15} strokeWidth={1.75} />
                    ) : (
                      <Eye size={15} strokeWidth={1.75} />
                    )}
                  </IconButton>
                </div>
                <Button
                  small
                  onClick={onSaveKey}
                  disabled={!keyValue.trim() || saving}
                >
                  {saving ? (
                    <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                  ) : (
                    <KeyRound size={13} strokeWidth={2} />
                  )}
                  {saving ? t("common.saving") : t("conn.save-key")}
                </Button>
                {editing && (
                  <Button
                    variant="secondary"
                    small
                    disabled={saving}
                    onClick={() => {
                      setEditing(false);
                      setKeyValue("");
                      setShowKey(false);
                      onError(errKey, null);
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                )}
                {getKeyLink}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-[var(--radius)] bg-[var(--bg-subtle)] px-2 py-1 font-mono text-meta">
                  {conn.key.masked}
                </code>
                <Button
                  variant="secondary"
                  small
                  disabled={saving}
                  onClick={() => {
                    setEditing(true);
                    setKeyValue("");
                    setSavedNotice(false);
                  }}
                >
                  <Pencil size={13} strokeWidth={2} />
                  {t("conn.change-key")}
                </Button>
                {getKeyLink}
                {/* Nút PHÁ HỦY tách hẳn khỏi cụm nút thường: `ml-auto` đẩy nó
                    sang mép phải hàng, không còn đứng sát "Đổi key" cùng cỡ
                    cùng chỗ - hai nút cạnh nhau thì trượt tay một nhịp là mất
                    key thật. */}
                <Button
                  variant="destructive"
                  small
                  className="ml-auto"
                  disabled={saving}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 size={13} strokeWidth={2} />
                  {saving ? t("common.deleting") : t("conn.delete-key")}
                </Button>
              </div>
            )}
          </Field>
          {savedNotice && (
            <p className="mt-2">
              <SavedNotice>{t("conn.saved")}</SavedNotice>
            </p>
          )}
        </Row>

        <Row>
          <div className="flex flex-col gap-2">
            <div>
              <Button
                variant="secondary"
                small
                onClick={runTest}
                disabled={testing}
              >
                {testing ? (
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                ) : (
                  <PlugZap size={14} strokeWidth={2} />
                )}
                {testing ? t("conn.testing") : t("conn.test")}
              </Button>
            </div>
            {testResult && (
              <Banner
                tone={testResult.ok ? "success" : "danger"}
                message={testResult.message}
              />
            )}
          </div>
        </Row>

        {conn.id === "claude" && (
          <Row>
            <p className="text-meta text-[var(--text-muted)]">
              {t("conn.claude-note")}
            </p>
          </Row>
        )}
      </div>

      {/* Modal xác nhận xóa API key - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={deleteOpen}
        title={t("conn.delete-key-title")}
        description={
          <>
            {t("conn.delete-desc-1")}{" "}
            <span className="font-medium">{conn.label}</span>? {t("conn.delete-desc-2")}
          </>
        }
        busy={saving}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDeleteKey}
      />
    </Card>
  );
}

/** URL tải cloudflared (trang downloads chính thức của Cloudflare). */
const CLOUDFLARED_DL_URL =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

/**
 * Card Cloudflare Tunnel - bật/tắt tunnel public cho dashboard ngay trên UI.
 * Poll GET /api/tunnel: 4s khi đang chạy (chờ URL quick tunnel), 10s khi tắt.
 */
function TunnelCard({ onError }: { onError: ErrorReporter }) {
  const { t } = useT();
  const [status, setStatus] = useState<TunnelStatus | null>(null);

  // Domain input - chỉ đồng bộ từ server khi user chưa gõ dở (dirty)
  const [domainValue, setDomainValue] = useState("");
  const [domainDirty, setDomainDirty] = useState(false);
  const [savingDomain, setSavingDomain] = useState(false);
  const [domainSaved, setDomainSaved] = useState(false);

  const [busy, setBusy] = useState(false); // start/stop đang gửi
  const [logOpen, setLogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await getTunnelStatus();
      setStatus(s);
      onError("tunnel-load", null);
    } catch (e) {
      onError("tunnel-load", {
        message: t("tunnel.load-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }, [onError, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll: 4s khi tunnel chạy (URL quick tunnel xuất hiện trong log sau vài giây), 10s khi tắt
  useEffect(() => {
    const iv = setInterval(load, status?.running ? 4000 : 10000);
    return () => clearInterval(iv);
  }, [load, status?.running]);

  // Điền domain từ server vào input (trừ lúc user đang gõ)
  useEffect(() => {
    if (status && !domainDirty) setDomainValue(status.domain ?? "");
  }, [status, domainDirty]);

  async function onSaveDomain() {
    if (savingDomain) return;
    setSavingDomain(true);
    onError("tunnel-action", null);
    setDomainSaved(false);
    try {
      const s = await setTunnelDomain(domainValue.trim() || null);
      setStatus(s);
      setDomainDirty(false);
      setDomainSaved(true);
    } catch (e) {
      onError("tunnel-action", {
        message: t("tunnel.domain-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSavingDomain(false);
    }
  }

  async function onToggle() {
    if (!status || busy) return;
    const wasRunning = status.running;
    setBusy(true);
    onError("tunnel-action", null);
    try {
      if (wasRunning) await stopTunnel();
      else await startTunnel();
      await load();
    } catch (e) {
      onError("tunnel-action", {
        message: wasRunning ? t("tunnel.stop-error") : t("tunnel.start-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const running = !!status?.running;

  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2">
          <CardIcon icon={Globe} />
          <span className="truncate">{t("tunnel.title")}</span>
        </span>
      }
      hint={{ titleKey: "help.tunnel.title", bodyKey: "help.tunnel.body" }}
      actions={
        <span className="flex flex-wrap items-center gap-2">
          {status && (
            <Badge
              tone={running ? "success" : "muted"}
              label={running ? t("tunnel.running") : t("tunnel.stopped")}
            />
          )}
          {running && status?.mode && (
            <span className="chip">
              {status.mode === "named"
                ? t("tunnel.mode-named")
                : t("tunnel.mode-quick")}
            </span>
          )}
        </span>
      }
    >
      <div className="divide-y divide-[var(--border)]">
        <Row>
          <p className="text-sm text-[var(--text-muted)]">{t("tunnel.desc")}</p>
          {/* Chưa cài cloudflared → hướng dẫn cài. Đây KHÔNG phải lỗi hệ thống
              mà là một trạng thái kèm cách xử lý, nên vẫn nằm trong card. */}
          {status && !status.installed && (
            <div className="mt-2">
              <Banner tone="danger" message={t("tunnel.not-installed")}>
                <p className="mt-1 text-meta">
                  {t("tunnel.install-cmd")}{" "}
                  <code className="select-all font-mono">
                    winget install --id Cloudflare.cloudflared
                  </code>
                </p>
                <a
                  href={CLOUDFLARED_DL_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-meta font-medium text-[var(--primary)] hover:underline"
                >
                  {t("tunnel.install-link")}
                  <ExternalLink size={12} strokeWidth={2} className="shrink-0" />
                </a>
              </Banner>
            </div>
          )}
        </Row>

        {/* Domain riêng (TUNNEL_DOMAIN) */}
        <Row>
          <Field
            label={t("tunnel.domain-label")}
            htmlFor="tunnel-domain"
            hint={t("tunnel.domain-hint")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="tunnel-domain"
                className="input min-w-[220px] flex-1"
                type="text"
                value={domainValue}
                placeholder="aiev.example.com"
                autoComplete="off"
                spellCheck={false}
                disabled={savingDomain}
                onChange={(e) => {
                  setDomainValue(e.target.value);
                  setDomainDirty(true);
                  setDomainSaved(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveDomain();
                }}
              />
              <Button
                small
                variant="secondary"
                onClick={onSaveDomain}
                disabled={savingDomain || !domainDirty}
              >
                {savingDomain ? (
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Check size={13} strokeWidth={2} />
                )}
                {savingDomain ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </Field>
          {domainSaved && (
            <p className="mt-2">
              <SavedNotice>{t("tunnel.domain-saved")}</SavedNotice>
            </p>
          )}
        </Row>

        {/* Bật / Tắt */}
        <Row>
          <div className="flex flex-wrap items-center gap-3">
            {/* Tắt tunnel KHÔNG mất dữ liệu gì - bật lại là xong. Tô đỏ ở đây
                làm loãng quy ước "đỏ = mất dữ liệu", nên trạng thái đang chạy
                dùng nút phụ. */}
            <Button
              small
              variant={running ? "secondary" : "primary"}
              onClick={onToggle}
              disabled={busy || !status || (!running && !status.installed)}
            >
              {busy ? (
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              ) : running ? (
                <Square size={13} strokeWidth={2} />
              ) : (
                <Play size={13} strokeWidth={2} />
              )}
              {busy
                ? running
                  ? t("tunnel.stopping")
                  : t("tunnel.starting")
                : running
                  ? t("tunnel.stop")
                  : t("tunnel.start")}
            </Button>
            {running && !status?.url && (
              <span className="text-meta text-[var(--text-muted)]">
                {t("tunnel.url-pending")}
              </span>
            )}
          </div>

          {/* URL đang hoạt động - QR "Kết nối điện thoại" tự dùng địa chỉ này */}
          {running && status?.url && (
            <div className="mt-3">
              <p className="label mb-1">{t("tunnel.url-label")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="select-all break-all rounded-[var(--radius)] bg-[var(--bg-subtle)] px-2 py-1 font-mono text-meta">
                  {status.url}
                </code>
                <CopyButton value={status.url} label={t("tunnel.copy")} />
              </div>
              <p className="mt-1 text-meta text-[var(--text-muted)]">
                {t("tunnel.qr-note")}
              </p>
            </div>
          )}
        </Row>

        {/* Log cloudflared - collapse */}
        {status && status.lastLog.length > 0 && (
          <Row>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-meta font-medium text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
              aria-expanded={logOpen}
              onClick={() => setLogOpen((v) => !v)}
            >
              <ChevronDown
                size={13}
                strokeWidth={2}
                className={`shrink-0 transition-transform ${logOpen ? "" : "-rotate-90"}`}
              />
              {t("tunnel.log")}
            </button>
            {logOpen && (
              <Panel className="mt-2">
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-meta text-[var(--text-muted)]">
                  {status.lastLog.join("\n")}
                </pre>
              </Panel>
            )}
          </Row>
        )}

        {/* Cảnh báo: dashboard chưa có đăng nhập */}
        <Row>
          <Banner tone="danger" message={t("tunnel.warn-public")} />
        </Row>
      </div>
    </Card>
  );
}

export default function ConnectionsPage() {
  const { t } = useT();
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Lỗi của mọi thao tác trong các card, gom về đây. Có khóa theo nguồn để hai
   * card không chùi lỗi của nhau; `report` ổn định (deps rỗng) vì TunnelCard
   * đưa nó vào deps của `load` - đổi định danh mỗi lần render là interval poll
   * bị dựng lại liên tục.
   */
  const [actionErrors, setActionErrors] = useState<
    Record<string, { message: string; detail?: string }>
  >({});
  const report = useCallback<ErrorReporter>((key, err) => {
    setActionErrors((prev) => {
      if (!err) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: err };
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await getConnections();
      setConnections(res.connections);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex w-full flex-col gap-4">
      <PageHeader
        title={t("nav.connections")}
        hint={{
          titleKey: "help.connections.title",
          bodyKey: "help.connections.body",
        }}
        subtitle={t("conn.subtitle")}
      />

      {error && (
        <ErrorBanner message={t("conn.load-error")} detail={error} />
      )}
      {/* Lỗi lưu / hành động của mọi card - cùng một chỗ với lỗi tải, giống
          hệt trang Cấu hình. */}
      {Object.entries(actionErrors).map(([key, e]) => (
        <ErrorBanner key={key} message={e.message} detail={e.detail} />
      ))}

      {/* Tunnel nằm CHUNG lưới với các provider: nó từng có một lưới riêng chỉ
          chứa đúng một card, nên chiếm 1/3 bề rộng và bỏ trống 2/3 còn lại. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {connections === null && !error
          ? [0, 1, 2].map((i) => (
              <Skeleton key={i} className="w-full" height={220} />
            ))
          : (connections ?? []).map((c) => (
              <ProviderCard
                key={c.id}
                conn={c}
                onUpdate={setConnections}
                onError={report}
              />
            ))}
        <TunnelCard onError={report} />
      </div>

      {connections && connections.length === 0 && (
        <Card>
          <EmptyState icon={Plug} description={t("conn.empty")} />
        </Card>
      )}
    </div>
  );
}
