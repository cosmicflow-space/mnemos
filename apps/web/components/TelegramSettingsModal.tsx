"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";

type Status = {
  enabled: boolean;
  hasToken: boolean;
  providerId: string;
  pairing: { code: string; expiresAt: number } | null;
  chats: Array<{ chatId: number; label: string | null; pairedAt: number }>;
};

/**
 * Telegram remote channel settings: paste a bot token, enable the poller, mint
 * a single-use pairing code, and manage paired chats. The token is write-only
 * here (saved to ~/.mnemos/.env); it's never returned to the browser.
 */
export function TelegramSettingsModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/telegram", { cache: "no-store" });
      if (r.ok) setStatus((await r.json()) as Status);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch("/api/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error((data.message as string) || "request failed");
    return data;
  }

  async function saveToken() {
    const t = token.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const d = await post({ action: "set-token", token: t });
      setToken("");
      setNote(`✓ Bot verified${d.botUsername ? ` (@${d.botUsername})` : ""} and saved locally.`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await post({ action: next ? "enable" : "disable" });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function genPairingCode() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await post({ action: "pair-code" });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(chatId: number) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/telegram", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId }),
      });
      if (!r.ok) throw new Error("revoke failed");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const pairing = status?.pairing ?? null;

  return (
    <Modal title="Telegram" onClose={onClose} maxWidth="max-w-xl">
      <p className="text-xs text-muted mb-2 leading-relaxed">
        Ask your Mnemos from your phone. Create a bot with{" "}
        <span className="font-mono">@BotFather</span> on Telegram, paste its token below,
        enable the channel, then pair your phone. Mnemos reaches out to Telegram (no
        public server, nothing inbound exposed).
      </p>
      <a
        href="/telegram-guide"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mb-4 text-xs text-cyan-400 hover:text-cyan-300 underline"
      >
        New to Telegram bots? Step-by-step guide ↗
      </a>

      {/* Step 1 — token */}
      <div className="mb-4">
        <div className="text-[11px] uppercase tracking-wider text-muted mb-1">
          1 · Bot token
        </div>
        {status?.hasToken ? (
          <div className="text-xs text-emerald-400 mb-1">✓ A bot token is configured.</div>
        ) : (
          <div className="text-xs text-muted mb-1">No token yet.</div>
        )}
        <div className="flex gap-2">
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveToken();
            }}
            type="password"
            placeholder={status?.hasToken ? "Paste a new token to replace" : "123456:ABC-DEF…"}
            disabled={busy}
            className="flex-1 bg-surface border border-line rounded-md px-3 py-2 text-sm text-fg font-mono focus:outline-none focus:border-cyan-500 disabled:opacity-50"
          />
          <button
            onClick={() => void saveToken()}
            disabled={busy || !token.trim()}
            className="rounded-md bg-cyan-500 px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50 shrink-0"
          >
            Verify & save
          </button>
        </div>
        <p className="text-[11px] text-muted/70 mt-1">
          Stored in <span className="font-mono">~/.mnemos/.env</span> (chmod 600). Never
          paste a token into a chat — treat it like a password.
        </p>
      </div>

      {/* Step 2 — enable */}
      <div className="mb-4 border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wider text-muted mb-1">2 · Channel</div>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={busy || !status?.hasToken}
            onChange={(e) => void toggleEnabled(e.target.checked)}
          />
          <span>Enable the Telegram bot {status?.enabled ? "(listening)" : "(off)"}</span>
        </label>
        <p className="text-[11px] text-muted/70 mt-1">
          Replies use your configured model (<span className="font-mono">{status?.providerId ?? "ollama"}</span>).
          Your documents stay local; questions &amp; answers transit Telegram.
        </p>
      </div>

      {/* Step 3 — pair */}
      <div className="mb-4 border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wider text-muted mb-1">3 · Pair your phone</div>
        {pairing ? (
          <div className="rounded-md border border-cyan-700/50 bg-cyan-500/10 px-3 py-2">
            <div className="text-xs text-muted">Send this to your bot from Telegram:</div>
            <div className="font-mono text-lg text-cyan-300 tracking-widest my-1 select-all">
              /pair {pairing.code}
            </div>
            <div className="text-[11px] text-muted/70">
              Single-use · expires{" "}
              {new Date(pairing.expiresAt).toLocaleTimeString()}
            </div>
          </div>
        ) : (
          <button
            onClick={() => void genPairingCode()}
            disabled={busy || !status?.hasToken}
            className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-fg hover:border-cyan-700 transition disabled:opacity-50"
          >
            Generate pairing code
          </button>
        )}
      </div>

      {/* Paired chats */}
      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wider text-muted mb-2">
          Paired ({status?.chats.length ?? 0})
        </div>
        {!status || status.chats.length === 0 ? (
          <p className="text-xs text-muted">No paired chats yet.</p>
        ) : (
          <ul className="space-y-1">
            {status.chats.map((c) => (
              <li
                key={c.chatId}
                className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2"
              >
                <div className="text-xs text-fg">
                  {c.label ?? "(unknown)"}{" "}
                  <span className="text-muted font-mono">· {c.chatId}</span>
                </div>
                <button
                  onClick={() => void revoke(c.chatId)}
                  disabled={busy}
                  className="text-[11px] text-muted hover:text-red-400 transition"
                  title="Revoke this chat's access"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {note && <p className="text-xs text-emerald-400 mt-3">{note}</p>}
      {err && <p className="text-xs text-red-400 mt-3">{err}</p>}
    </Modal>
  );
}
