import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { childEnv, repoRoot } from "./config.js";

/** Adapter Gemini CLI stream-json sang cùng shape sự kiện với Claude/Codex. */
export interface GeminiQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
}

export interface GeminiRunOptions {
  prompt: string;
  sessionId?: string | null;
  model?: string | null;
}

function safeArg(value: string): string | null {
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

class GeminiExecQuery implements GeminiQuery {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exit: Promise<{ code: number | null; error: Error | null }>;
  private interrupted = false;

  constructor(private readonly options: GeminiRunOptions) {
    const args = ["--output-format", "stream-json", "--yolo"];
    if (options.model && options.model !== "gemini-auto") {
      const model = safeArg(options.model);
      if (model) args.push("--model", model);
    }
    if (options.sessionId) {
      const session = safeArg(options.sessionId);
      if (session) args.push("--resume", session);
    }

    const bin = process.env.GEMINI_BIN || "gemini";
    if (process.platform === "win32") {
      const command = [`"${bin}"`, ...args].join(" ");
      this.child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
        cwd: repoRoot,
        env: childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } else {
      this.child = spawn(bin, args, {
        cwd: repoRoot,
        env: childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    this.exit = new Promise((resolve) => {
      let spawnError: Error | null = null;
      this.child.once("error", (err) => { spawnError = err; });
      this.child.once("close", (code) => resolve({ code, error: spawnError }));
    });
    this.child.stdin.on("error", () => {});
    this.child.stdin.end(options.prompt, "utf8");
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGTERM");
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
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const type = String(event.type ?? "");
      if (type === "init") {
        const sessionId = event.session_id ?? event.sessionId;
        if (typeof sessionId === "string") yield { type: "system", subtype: "init", session_id: sessionId };
        continue;
      }
      if (type === "message" && event.role === "assistant") {
        const content = typeof event.content === "string" ? event.content : "";
        if (content) {
          finalText += content;
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: content } } };
        }
        continue;
      }
      if (type === "tool_use") {
        yield {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: String(event.tool_name ?? event.name ?? "GeminiTool"), input: event.parameters ?? event.input ?? {} }] },
        };
        continue;
      }
      if (type === "error") {
        failed = true;
        const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
        if (!finalText) finalText = message;
        continue;
      }
      if (type === "result") {
        resultEmitted = true;
        const status = String(event.status ?? "success");
        const response = typeof event.response === "string" ? event.response : finalText;
        const stats = event.stats && typeof event.stats === "object" ? event.stats as Record<string, unknown> : {};
        const usage = stats.usage && typeof stats.usage === "object" ? stats.usage as Record<string, unknown> : stats;
        yield {
          type: "result",
          subtype: failed || status !== "success" ? "gemini_error" : "success",
          result: response,
          total_cost_usd: 0,
          usage: {
            input_tokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
            output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
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
        subtype: ok ? "success" : this.interrupted ? "interrupted" : "gemini_error",
        result: finalText || detail || `Gemini CLI thoát mã ${ended.code}`,
      };
    }
  }
}

export function createGeminiQuery(options: GeminiRunOptions): GeminiQuery {
  return new GeminiExecQuery(options);
}
