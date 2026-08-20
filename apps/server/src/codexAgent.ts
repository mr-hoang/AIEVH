import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { childEnv, repoRoot } from "./config.js";

/**
 * Adapter biến JSONL của `codex exec` thành shape sự kiện tối thiểu mà agent.ts
 * đang dùng cho Claude Agent SDK. Nhờ vậy chat, SSE, interrupt, usage và
 * auto-resume dùng chung một đường code, không có hai pipeline lệch hành vi.
 */
export interface CodexQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
}

export interface CodexRunOptions {
  prompt: string;
  sessionId?: string | null;
  model?: string | null;
  effort?: string | null;
  sandbox?: "read-only" | "workspace-write";
}

function itemTool(item: Record<string, unknown>): { name: string; input: unknown } | null {
  const type = String(item.type ?? "");
  if (type === "command_execution") {
    return {
      name: "CodexCommand",
      input: { command: item.command ?? "", status: item.status ?? "" },
    };
  }
  if (type === "file_change") {
    return { name: "CodexFileChange", input: item };
  }
  if (type === "mcp_tool_call") {
    return { name: String(item.tool ?? item.name ?? "CodexMcpTool"), input: item };
  }
  if (type === "web_search") return { name: "CodexWebSearch", input: item };
  return null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.message === "string") return v.message;
    if (typeof v.error === "string") return v.error;
  }
  return "Codex kết thúc với lỗi không xác định";
}

class CodexExecQuery implements CodexQuery {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exit: Promise<{ code: number | null; error: Error | null }>;
  private interrupted = false;

  constructor(private readonly options: CodexRunOptions) {
    const args = ["exec", "--json", "--sandbox", options.sandbox ?? "workspace-write"];
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("-c", `model_reasoning_effort=\"${options.effort}\"`);
    if (options.sessionId) args.push("resume", options.sessionId, "-");
    else args.push("-");

    const fallbackKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
    const extraEnv = fallbackKey ? { CODEX_API_KEY: fallbackKey } : undefined;
    this.child = spawn(process.env.CODEX_BIN || "codex", args, {
      cwd: repoRoot,
      env: childEnv(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exit = new Promise((resolve) => {
      let spawnError: Error | null = null;
      this.child.once("error", (err) => {
        spawnError = err;
      });
      this.child.once("close", (code) => resolve({ code, error: spawnError }));
    });
    // Nếu binary không tồn tại, Windows có thể phát EPIPE khi ghi prompt trước
    // lúc event `error` được phát. Listener này ngăn lỗi stream thành unhandled.
    this.child.stdin.on("error", () => {});
    this.child.stdin.end(options.prompt, "utf8");
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.child.exitCode !== null || this.child.killed) return;
    this.child.kill("SIGTERM");
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    const stderr: string[] = [];
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      if (stderr.join("").length < 12_000) stderr.push(chunk);
    });

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    let finalText = "";
    let resultEmitted = false;
    let failed = false;

    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(event.type ?? "");

      if (type === "thread.started" && typeof event.thread_id === "string") {
        yield { type: "system", subtype: "init", session_id: event.thread_id };
        continue;
      }

      if (type === "item.started" || type === "item.completed") {
        const item = event.item;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          if (type === "item.completed" && record.type === "agent_message") {
            const text = typeof record.text === "string" ? record.text : "";
            if (text) {
              finalText = text;
              yield {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text },
                },
              };
            }
          } else {
            const tool = itemTool(record);
            if (tool) {
              yield {
                type: "assistant",
                message: { content: [{ type: "tool_use", name: tool.name, input: tool.input }] },
              };
            }
          }
        }
        continue;
      }

      if (type === "error" || type === "turn.failed") {
        failed = true;
        const message = errorText(event.error ?? event);
        if (!finalText) finalText = message;
        continue;
      }

      if (type === "turn.completed") {
        const usage =
          event.usage && typeof event.usage === "object"
            ? (event.usage as Record<string, unknown>)
            : {};
        resultEmitted = true;
        yield {
          type: "result",
          subtype: failed ? "codex_error" : "success",
          result: finalText,
          total_cost_usd: 0,
          usage: {
            input_tokens: Number(usage.input_tokens ?? 0),
            cache_read_input_tokens: Number(usage.cached_input_tokens ?? 0),
            output_tokens:
              Number(usage.output_tokens ?? 0) + Number(usage.reasoning_output_tokens ?? 0),
          },
        };
      }
    }

    const ended = await this.exit;
    if (!resultEmitted) {
      const detail = (ended.error?.message || stderr.join("").trim()).slice(0, 4000);
      const ok = !this.interrupted && !failed && ended.code === 0;
      yield {
        type: "result",
        subtype: ok ? "success" : this.interrupted ? "interrupted" : "codex_error",
        result:
          finalText ||
          detail ||
          (ended.code === null ? "Codex không khởi động được" : `Codex thoát mã ${ended.code}`),
      };
    }
  }
}

export function createCodexQuery(options: CodexRunOptions): CodexQuery {
  return new CodexExecQuery(options);
}
