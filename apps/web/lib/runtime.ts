/**
 * Shared runtime singleton.
 *
 * The plugin registry and DB connection are created once per process and cached
 * here. API routes import these getters; they pay the construction cost on the
 * first call and reuse on subsequent calls.
 *
 * In Next.js dev mode the module is re-evaluated on hot reload, so the DB
 * handle is also re-opened. better-sqlite3 handles this fine.
 */

import {
  loadBundledPlugins,
  type PluginRegistry,
} from "@mnemos/core";
import { openDb, type MnemosDb } from "@mnemos/db";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

let cachedRegistry: PluginRegistry | null = null;
let cachedDb: MnemosDb | null = null;

export function getRegistry(): PluginRegistry {
  if (!cachedRegistry) {
    cachedRegistry = loadBundledPlugins();
  }
  return cachedRegistry;
}

export function getStateDir(): string {
  const dir = process.env.MNEMOS_STATE_DIR ?? join(homedir(), ".mnemos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDb(): MnemosDb {
  if (!cachedDb) {
    const path = process.env.MNEMOS_DB_PATH ?? join(getStateDir(), "mnemos.db");
    cachedDb = openDb({ path });
  }
  return cachedDb;
}

/** For tests: reset all singletons. */
export function __resetRuntimeForTests(): void {
  if (cachedDb) cachedDb.close();
  cachedDb = null;
  cachedRegistry = null;
}
