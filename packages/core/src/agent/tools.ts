/**
 * Read-only agent tools (Phase 3).
 *
 * Tools are the ONLY way the agent reaches the world, and at this phase that
 * world is strictly READ: there is no command execution and no write. The agent
 * can both *semantically* search indexed content (rag_search) and *navigate the
 * workspace* — list directories, find files by name, read a file, and grep file
 * contents — but every filesystem operation is confined to the user's REGISTERED
 * source roots (the existing trust boundary) and bounded in size. Each tool
 * receives a ToolContext of injected capabilities, so core stays free of direct
 * db/fs wiring and the tools are testable with fakes.
 */

import type { SearchHit } from "@mnemos/db";

/** A directory entry surfaced by list_dir. */
export type DirEntry = { name: string; kind: "dir" | "file" };
/** A grep hit: a matching line within a file. */
export type GrepMatch = { path: string; line: number; text: string };

/**
 * Confined, read-only view of the workspace (the user's registered source
 * roots). CONTRACT: every method is read-only and may only touch paths inside a
 * registered source — implementations realpath-resolve and reject escapes. The
 * factory `buildWorkspaceFs` in workspace.ts provides the vetted implementation.
 */
export type WorkspaceFs = {
  /** List entries under a path (omit/empty → the registered source roots). */
  listDir: (path?: string) => Promise<DirEntry[]>;
  /** Find files whose path contains `pattern` (case-insensitive) across sources. */
  findFiles: (pattern: string) => Promise<string[]>;
  /** Read a file's text (size-capped) within a source. */
  readFile: (path: string) => Promise<string>;
  /** Search file contents for `pattern` across sources (or under `path`). */
  grep: (pattern: string, path?: string) => Promise<GrepMatch[]>;
};

/**
 * The capabilities the read-only tools may use. CONTRACT: every member MUST be
 * read-only and side-effect-free. The type can't prove a callback doesn't write,
 * so the caller wiring this context (the route) injects ONLY vetted read-only
 * implementations: `search` = vector search; `fs` = the confined workspace view.
 */
export type ToolContext = {
  /** Semantic search over indexed chunks. MUST be read-only (vector search). */
  search: (query: string, k: number) => Promise<SearchHit[]>;
  /** Confined read-only workspace access. Absent → file tools are unavailable. */
  fs?: WorkspaceFs;
};

export type ToolResult = { ok: true; observation: string } | { ok: false; error: string };

export type AgentTool = {
  name: string;
  /** One line shown to the model in the system prompt (name + args + effect). */
  description: string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

const MAX_K = 10;
const SNIPPET_CHARS = 600;
const MAX_LIST = 200;
const MAX_FIND = 200;
const READFILE_CHARS = 8000;
const MAX_GREP = 100;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const ragSearch: AgentTool = {
  name: "rag_search",
  description:
    'Semantic search over the user\'s INDEXED content. args: {"query": string, "k"?: 1-10 (default 5)}. Best for "what does X say about Y". Returns numbered chunks with file paths.',
  async run(args, ctx) {
    const query = str(args.query);
    if (!query) return { ok: false, error: "rag_search requires a non-empty 'query'." };
    const rawK = typeof args.k === "number" && Number.isFinite(args.k) ? Math.floor(args.k) : 5;
    const k = Math.min(Math.max(rawK, 1), MAX_K);
    const hits = await ctx.search(query, k);
    if (hits.length === 0) return { ok: true, observation: "No matching chunks found." };
    const body = hits
      .map((h, i) => {
        const text = h.text.length > SNIPPET_CHARS ? `${h.text.slice(0, SNIPPET_CHARS)}…` : h.text;
        return `[${i + 1}] ${h.filePath}\n${text}`;
      })
      .join("\n\n");
    return { ok: true, observation: body };
  },
};

const listDir: AgentTool = {
  name: "list_dir",
  description:
    'List directories/files. args: {"path"?: string}. Omit path to list your registered source roots. Use this to navigate and to COUNT items in a folder.',
  async run(args, ctx) {
    if (!ctx.fs) return { ok: false, error: "workspace access is not available." };
    try {
      const entries = (await ctx.fs.listDir(str(args.path) || undefined)).slice(0, MAX_LIST);
      const dirs = entries.filter((e) => e.kind === "dir").length;
      const files = entries.filter((e) => e.kind === "file").length;
      const lines = entries.map((e) => `${e.kind === "dir" ? "📁" : "📄"} ${e.name}`).join("\n");
      return { ok: true, observation: `${dirs} dir(s), ${files} file(s):\n${lines}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const findFiles: AgentTool = {
  name: "find_files",
  description:
    'Find files whose path contains a substring (case-insensitive) across all sources. args: {"pattern": string}. Returns matching paths + a total count — ideal for "how many X files".',
  async run(args, ctx) {
    if (!ctx.fs) return { ok: false, error: "workspace access is not available." };
    const pattern = str(args.pattern);
    if (!pattern) return { ok: false, error: "find_files requires a non-empty 'pattern'." };
    try {
      const all = await ctx.fs.findFiles(pattern);
      const shown = all.slice(0, MAX_FIND);
      const more = all.length > shown.length ? `\n…(${all.length - shown.length} more)` : "";
      return {
        ok: true,
        observation: `${all.length} file(s) match "${pattern}":\n${shown.join("\n")}${more}`,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const readFile: AgentTool = {
  name: "read_file",
  description:
    'Read a file\'s text (size-capped). args: {"path": string}. The path must be inside a registered source.',
  async run(args, ctx) {
    if (!ctx.fs) return { ok: false, error: "workspace access is not available." };
    const path = str(args.path);
    if (!path) return { ok: false, error: "read_file requires a 'path'." };
    try {
      const text = await ctx.fs.readFile(path);
      const clipped = text.length > READFILE_CHARS ? `${text.slice(0, READFILE_CHARS)}\n…(truncated)` : text;
      return { ok: true, observation: clipped };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const grep: AgentTool = {
  name: "grep",
  description:
    'Search file CONTENTS for a literal substring (case-insensitive) across sources. args: {"pattern": string, "path"?: string}. Returns file:line matches + count.',
  async run(args, ctx) {
    if (!ctx.fs) return { ok: false, error: "workspace access is not available." };
    const pattern = str(args.pattern);
    if (!pattern) return { ok: false, error: "grep requires a non-empty 'pattern'." };
    try {
      const matches = (await ctx.fs.grep(pattern, str(args.path) || undefined)).slice(0, MAX_GREP);
      if (matches.length === 0) return { ok: true, observation: `No content matches for "${pattern}".` };
      const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
      return { ok: true, observation: `${matches.length} match(es) for "${pattern}":\n${lines}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/** The read-only tool set available to the agent loop at this phase. */
export const READ_ONLY_TOOLS: readonly AgentTool[] = [ragSearch, findFiles, listDir, readFile, grep];

export function getTool(name: string): AgentTool | undefined {
  return READ_ONLY_TOOLS.find((t) => t.name === name);
}
