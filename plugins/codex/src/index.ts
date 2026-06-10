import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Plugin,
  ChatProvider,
  ChatMessage,
  ChatOptions,
  ChatChunk,
  ModelInfo,
  CredentialSchema,
} from "@mnemos/plugin-sdk";

/**
 * Codex ChatProvider — answers through the Codex agent runtime instead of a
 * raw completions API.
 *
 * Auth: with no credentials at all, the SDK reuses the operator's existing
 * `codex login` session (~/.codex/auth.json) — ChatGPT-plan usage, no API key,
 * metered against the plan's rate windows. An optional `apiKey` credential
 * (CODEX_API_KEY) swaps to metered API billing; OpenAI recommends that for
 * shared/CI environments, while the login session is the normal path on a
 * personal machine — which is exactly Mnemos's trust model.
 */
const credentialSchema: CredentialSchema = {
  type: "codexAuth",
  displayName: "Codex (ChatGPT plan)",
  fields: [
    {
      key: "apiKey",
      label: "API Key (optional)",
      type: "password",
      required: false,
      description:
        "Leave blank to use your `codex login` session (ChatGPT plan). Set to bill an OpenAI API key instead.",
    },
  ],
};

// Subscription auth has no per-token price — costs are deliberately absent so
// the UI shows these as plan-metered rather than implying $0.
const CHAT_MODELS: readonly ModelInfo[] = [
  // First entry is the default (no priced models → UI falls back to models[0]).
  { id: "gpt-5.4", displayName: "GPT-5.4 (Codex)", contextWindow: 200000 },
  { id: "gpt-5.5", displayName: "GPT-5.5 (Codex)", contextWindow: 200000 },
];

const DEFAULT_MODEL = "gpt-5.4";

function codexAuthPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
}

/** True when either auth path is available: a CLI login session or an API key. */
export function hasCodexAuth(): boolean {
  return Boolean(process.env.CODEX_API_KEY?.trim()) || existsSync(codexAuthPath());
}

/**
 * The Codex agent takes one prompt string per turn, not a message array, so
 * the assembled RAG conversation is flattened. System content (instructions +
 * retrieved chunks) leads, then prior turns, then the live question.
 */
function flattenMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(m.content);
    else if (m.role === "user") parts.push(`User: ${m.content}`);
    else parts.push(`Assistant: ${m.content}`);
  }
  parts.push(
    "Respond with the assistant's next answer only — no role prefix, no commentary about these instructions.",
  );
  return parts.join("\n\n");
}

class CodexChatProvider implements ChatProvider {
  readonly id = "codex";
  readonly displayName = "Codex (ChatGPT plan)";
  readonly credentialSchema = credentialSchema;

  private client: Codex | null = null;
  private workdir: string | null = null;

  async initialize(credentials: Record<string, string>): Promise<void> {
    const apiKey = credentials.apiKey?.trim();
    if (!apiKey && !hasCodexAuth()) {
      throw new Error(
        "Codex provider needs auth: run `codex login` once (ChatGPT plan), or set CODEX_API_KEY.",
      );
    }
    this.client = new Codex(apiKey ? { apiKey } : {});
    // The Codex agent can read files in its working directory. Mnemos's
    // invariant is that frontier models only ever see retrieved chunks, so
    // every turn runs in a dedicated EMPTY directory — never the server cwd.
    this.workdir = join(
      process.env.MNEMOS_STATE_DIR ?? join(homedir(), ".mnemos"),
      "workspace",
      "codex",
    );
    mkdirSync(this.workdir, { recursive: true });
  }

  async *chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    if (!this.client || !this.workdir) {
      throw new Error("Codex provider not initialized. Call initialize() first.");
    }

    // Locked-down agent turn: no writes, no web search, no approval prompts
    // (there is no human at the CLI to approve anything). maxTokens/temperature
    // aren't part of the Codex turn surface — accepted silently.
    const thread = this.client.startThread({
      model: opts?.model ?? DEFAULT_MODEL,
      sandboxMode: "read-only",
      workingDirectory: this.workdir,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      webSearchMode: "disabled",
      modelReasoningEffort: "low",
    });

    const { events } = await thread.runStreamed(
      flattenMessages(messages),
      opts?.signal ? { signal: opts.signal } : {},
    );

    // agent_message items arrive as growing snapshots (item.updated), not
    // deltas — emit the unseen suffix each time, keyed by item id.
    const seen = new Map<string, string>();
    for await (const event of events as AsyncGenerator<ThreadEvent>) {
      if (opts?.signal?.aborted) return;
      switch (event.type) {
        case "item.started":
        case "item.updated":
        case "item.completed": {
          const item = event.item;
          if (item.type === "agent_message") {
            const prev = seen.get(item.id) ?? "";
            if (item.text.length > prev.length && item.text.startsWith(prev)) {
              seen.set(item.id, item.text);
              yield { delta: item.text.slice(prev.length) };
            } else if (item.text !== prev) {
              // Snapshot rewrote earlier text (rare) — restart from scratch.
              seen.set(item.id, item.text);
              yield { delta: item.text };
            }
          } else if (item.type === "error") {
            throw new Error(`Codex turn error: ${item.message}`);
          }
          break;
        }
        case "turn.completed":
          yield {
            delta: "",
            finishReason: "stop",
            usage: {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
            },
          };
          break;
        case "turn.failed":
          throw new Error(`Codex turn failed: ${event.error.message}`);
        case "error":
          throw new Error(`Codex stream error: ${event.message}`);
        default:
          break; // thread.started / turn.started — nothing to surface
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [...CHAT_MODELS];
  }
}

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-codex",
    displayName: "Codex (ChatGPT plan)",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  chatProviders: [new CodexChatProvider()],
};

export default plugin;
