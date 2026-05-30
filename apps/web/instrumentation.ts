/**
 * Next.js instrumentation hook — `register()` runs once per server process on
 * startup. We use it to start the background source watcher (periodic
 * incremental re-scan). Node runtime only; skipped on the edge runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWatcher } = await import("./lib/watcher");
    startWatcher();
  }
}
