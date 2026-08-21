"use client";

/**
 * Chọn engine/model Codex hoặc Claude + chế độ (effort) cho phiên AI.
 * - Modal "Bắt đầu edit bằng AI" (khối AiModelBlock đầy đủ, có badge kết nối)
 * - ChatThread khi tạo phiên MỚI (hàng AiModelInlineRow gọn phía trên input)
 *
 * Danh sách model + trạng thái kết nối lấy từ GET /api/providers, cache
 * module-level trong một phiên UI. Gemini chỉ hiện dạng thông tin - provider
 * đó dành cho tính năng Tạo ảnh, không dùng cho chat/edit.
 */

import { AlertTriangle, Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Field } from "@/components/Field";
import { InfoHint } from "@/components/InfoHint";
import { Panel } from "@/components/Panel";
import {
  getClaudeModels,
  getProviders,
  type AgentEffort,
  type Provider,
  type ProviderModel,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Model mặc định cho phiên AI mới.
 *
 * Terra là mặc định cân bằng. Người dùng ChatGPT Pro có thể dùng phiên Codex
 * local; khi chuyển sang API key, Dashboard vẫn ghi token/chi phí theo model.
 * Model mạnh/nhanh hơn luôn có thể chọn cho từng phiên.
 */
export const DEFAULT_MODEL = "gpt-5.6-terra";
export const DEFAULT_EFFORT: AgentEffort = "medium";

export const EFFORT_OPTIONS: {
  value: AgentEffort;
  label: string;
  hint: string;
}[] = [
  // label/hint là KEY dictionary - dịch bằng t() lúc render
  { value: "low", label: "effort.low", hint: "effort.low-hint" },
  { value: "medium", label: "effort.medium", hint: "effort.medium-hint" },
  { value: "high", label: "effort.high", hint: "effort.high-hint" },
];

/**
 * Fallback khi chưa fetch được /api/providers - chỉ để select không trống.
 * Nhãn phải BÁM THEO DEFAULT_MODEL: trước đây nó ghi cứng "Claude Fable 5",
 * nên đổi model mặc định mà quên chỗ này là ô select hiện sai tên model, người
 * dùng tưởng đang chạy model khác hẳn với thứ thật sự được gọi.
 */
const FALLBACK_CODEX_MODELS = [
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (khuyên dùng)" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (mạnh nhất)" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (nhanh)" },
];
const FALLBACK_CLAUDE_MODELS = [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }];
const FALLBACK_GEMINI_MODELS = [{ id: "gemini-auto", label: "Gemini Auto (khuyên dùng)" }];

// KEY dictionary - dịch bằng t() lúc render
const GEMINI_TOOLTIP = "model.gemini-tooltip";

// Cache module-level - providers thay đổi khi sửa .env/đăng nhập lại,
// một lần fetch mỗi phiên UI là đủ.
let providersCache: Provider[] | null = null;
let providersPromise: Promise<Provider[]> | null = null;

/**
 * Bust cache providers - gọi sau khi đổi/xóa API key ở trang Kết nối để các
 * select model/provider nơi khác fetch lại danh sách mới ở lần mount sau.
 */
export function refreshProviders(): void {
  providersCache = null;
  providersPromise = null;
}

export function useProviders(): {
  providers: Provider[] | null;
  error: string | null;
} {
  const [providers, setProviders] = useState<Provider[] | null>(providersCache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (providersCache) return;
    let alive = true;
    if (!providersPromise) {
      providersPromise = getProviders().then((r) => {
        providersCache = r.providers;
        return r.providers;
      });
    }
    providersPromise
      .then((list) => {
        if (alive) setProviders(list);
      })
      .catch((e) => {
        // fetch hỏng → cho phép thử lại ở lần mount sau
        providersPromise = null;
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return { providers, error };
}

/**
 * Danh sách model Claude live - lazy: chỉ fetch khi user chạm vào select Model
 * lần đầu (load()), giống useGeminiImageModels. Server cache 10 phút; chưa
 * fetch xong thì UI vẫn dùng danh sách tĩnh từ /api/providers.
 */
export function useClaudeModels() {
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const startedRef = useRef(false);

  const load = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    try {
      const { models } = await getClaudeModels();
      setModels(models);
    } catch {
      // lỗi mạng → cho phép thử lại ở lần focus sau, UI vẫn còn danh sách tĩnh
      startedRef.current = false;
    }
  }, []);

  return { models, load };
}

interface PickerProps {
  model: string;
  effort: AgentEffort;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: AgentEffort) => void;
  disabled?: boolean;
}

function claudeModels(claude: Provider | undefined) {
  return claude && claude.models.length > 0 ? claude.models : FALLBACK_CLAUDE_MODELS;
}

function codexModels(openai: Provider | undefined) {
  return openai && openai.models.length > 0 ? openai.models : FALLBACK_CODEX_MODELS;
}

function isCodexModel(model: string): boolean {
  return /^gpt-|^codex-/i.test(model);
}
function isGeminiModel(model: string): boolean {
  return /^gemini-(?:auto|\d)/i.test(model);
}

/** Khối "AI thực hiện" trong modal Bắt đầu edit - model + mode + trạng thái kết nối. */
export function AiModelBlock({
  model,
  effort,
  onModelChange,
  onEffortChange,
  disabled = false,
}: PickerProps) {
  const { t } = useT();
  const { providers } = useProviders();
  const claude = providers?.find((p) => p.id === "claude");
  const openai = providers?.find((p) => p.id === "openai");
  const gemini = providers?.find((p) => p.id === "gemini");
  const { models: liveModels, load: loadClaudeModels } = useClaudeModels();
  const cModels = liveModels ?? claudeModels(claude);
  const oModels = codexModels(openai);
  const gModels = (gemini?.models ?? FALLBACK_GEMINI_MODELS).filter((m) => /^gemini-(?:auto|\d)/i.test(m.id));
  const models = [...oModels, ...cModels, ...gModels];
  const active = isCodexModel(model) ? openai : isGeminiModel(model) ? gemini : claude;
  // Model đã lưu không (chưa) nằm trong danh sách → vẫn hiển thị bằng id thô
  const modelMissing = model !== "" && !models.some((m) => m.id === model);

  return (
    <Panel
      title={t("model.performer")}
      actions={
        // "Claude" phải đứng ngay trước huy hiệu: một mình chữ "Đã kết nối"
        // cạnh tiêu đề nhóm "AI thực hiện" thì không nói được là CÁI GÌ đang
        // kết nối. Bản cũ có chữ này, chuyển sang Panel thì rơi mất.
        active && (
          <span className="flex items-center gap-2">
            <span className="text-meta font-medium">{active.label}</span>
            {active.connected ? (
              <Badge
                tone="success"
                label={
                  active.source === "api-key"
                    ? t("model.connected-api-key")
                    : t("model.connected-subscription")
                }
              />
            ) : (
              <Badge tone="danger" label={t("model.not-connected")} />
            )}
          </span>
        )
      }
    >
      {active && !active.connected && (
        <p className="flex items-start gap-2 text-sm font-medium text-[var(--danger)]">
          <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
          {isCodexModel(model) ? t("model.codex-warning") : isGeminiModel(model) ? "Chưa kết nối Antigravity CLI. Mở trang Kết nối để đăng nhập Google Subscription hoặc nhập API key dự phòng." : t("model.claude-warning")}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("model.model")} htmlFor="ai-model">
          <select
            id="ai-model"
            className="input"
            value={model}
            disabled={disabled}
            onFocus={loadClaudeModels}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {modelMissing && <option value={model}>{model}</option>}
            <optgroup label="ChatGPT / Codex">
              {oModels.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </optgroup>
            <optgroup label="Claude">
              {cModels.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </optgroup>
            <optgroup label="Gemini">
              {gModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </optgroup>
          </select>
        </Field>
        <Field label={t("model.effort")} htmlFor="ai-effort">
          <select
            id="ai-effort"
            className="input"
            value={effort}
            disabled={disabled}
            onChange={(e) => onEffortChange(e.target.value as AgentEffort)}
          >
            {EFFORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)} - {t(o.hint)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {/* GỢI Ý, KHÔNG PHẢI CƯỠNG CHẾ - model mặc định giữ nguyên, người dùng
          vẫn tự quyết. Đặt ngay dưới ô chọn vì đây đúng là lúc quyết định, chứ
          không phải sau khi phiên đã chạy và tiền đã tiêu. Chỉ có ở khối đầy đủ
          (modal Bắt đầu edit); hàng inline trong ChatThread không nhét được một
          banner mà không phá nhịp một hàng. */}
      <Banner
        tone="info"
        message={
          <>
            {t("model.cost-tip")}{" "}
            <InfoHint
              titleKey="help.model-cost.title"
              bodyKey="help.model-cost.body"
              className="align-middle"
            />
          </>
        }
      />
    </Panel>
  );
}

/** Hàng chọn model/mode gọn - hiện trong ChatThread khi tạo phiên mới. */
export function AiModelInlineRow({
  model,
  effort,
  onModelChange,
  onEffortChange,
  disabled = false,
}: PickerProps) {
  const { t } = useT();
  const { providers } = useProviders();
  const claude = providers?.find((p) => p.id === "claude");
  const openai = providers?.find((p) => p.id === "openai");
  const gemini = providers?.find((p) => p.id === "gemini");
  const { models: liveModels, load: loadClaudeModels } = useClaudeModels();
  // Chưa fetch live → tạm dùng danh sách tĩnh từ /api/providers
  const cModels = liveModels ?? claudeModels(claude);
  const oModels = codexModels(openai);
  const gModels = (gemini?.models ?? FALLBACK_GEMINI_MODELS).filter((m) => /^gemini-(?:auto|\d)/i.test(m.id));
  const models = [...oModels, ...cModels, ...gModels];
  const active = isCodexModel(model) ? openai : isGeminiModel(model) ? gemini : claude;
  // Model đã lưu không (chưa) nằm trong danh sách → vẫn hiển thị bằng id thô
  const modelMissing = model !== "" && !models.some((m) => m.id === model);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* `.input` chuẩn, chỉ ghi đè BỀ RỘNG (w-auto) để hai select nằm gọn trên
          một hàng - chiều cao và cỡ chữ giữ nguyên như mọi ô nhập khác. */}
      <select
        className="input w-auto"
        aria-label={t("model.aria-model")}
        value={model}
        disabled={disabled}
        onFocus={loadClaudeModels}
        onChange={(e) => onModelChange(e.target.value)}
      >
        {modelMissing && <option value={model}>{model}</option>}
        <optgroup label="ChatGPT / Codex">
          {oModels.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </optgroup>
        <optgroup label="Claude">
          {cModels.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </optgroup>
        <optgroup label="Gemini">
          {gModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </optgroup>
      </select>
      <select
        className="input w-auto"
        aria-label={t("model.aria-effort")}
        value={effort}
        disabled={disabled}
        onChange={(e) => onEffortChange(e.target.value as AgentEffort)}
      >
        {EFFORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.label)}
          </option>
        ))}
      </select>
      {active && !active.connected && (
        <span
          className="inline-flex items-center gap-1 text-meta font-medium text-[var(--danger)]"
          title={isCodexModel(model) ? t("model.codex-warning-short") : isGeminiModel(model) ? "Chưa kết nối Antigravity CLI" : t("model.claude-warning-short")}
        >
          <AlertTriangle size={13} strokeWidth={2} className="shrink-0" />
          {isCodexModel(model) ? t("model.codex-not-connected") : isGeminiModel(model) ? "Gemini chưa kết nối" : t("model.claude-not-connected")}
        </span>
      )}
    </div>
  );
}
