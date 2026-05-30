/**
 * Next.js instrumentation hook — `register()` runs once per server process on
 * startup. We use it to start the background source watcher (periodic
 * incremental re-scan). Node runtime only; skipped on the edge runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Load ~/.mnemos/.env into process.env before any background service reads
    // it (provider keys, the Telegram bot token, etc.).
    const { hydrateProcessEnv } = await import("./lib/config");
    hydrateProcessEnv();
    const { startWatcher } = await import("./lib/watcher");
    startWatcher();
    const { startTelegram } = await import("./lib/telegram");
    startTelegram();
  }
}
