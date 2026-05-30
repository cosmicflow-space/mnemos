export type SourceKind = "folder" | "file" | "url" | "mailbox";

export type Source = {
  id: number;
  path: string;
  kind: SourceKind;
  scope: "read-only";
  createdAt: number;
  updatedAt: number;
  /** Auto re-scan cadence in ms. 0 = manual only (no background re-scan). */
  watchIntervalMs: number;
  /** Epoch ms of the last scan (auto or manual). Null until first scanned. */
  lastScannedAt: number | null;
  /** User paused this source's ingestion. Persisted so a pause survives a
   * restart and the background watcher won't auto-resume it. */
  paused: boolean;
};

export type IngestStatus = "pending" | "partial" | "complete" | "failed";

export type TelegramChat = {
  chatId: number;
  label: string | null;
  sessionId: string | null;
  pairedAt: number;
};

export type TelegramState = {
  enabled: boolean;
  updateOffset: number;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
};

export type FileRow = {
  id: number;
  sourceId: number;
  path: string;
  contentHash: string;
  sizeBytes: number;
  mtime: number;
  loader: string;
  lastIngestedAt: number;
  ingestStatus: IngestStatus;
};

export type Chunk = {
  id: number;
  fileId: number;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
  metadata: Record<string, unknown> | null;
  createdAt: number;
};

export type Credential = {
  id: number;
  name: string;
  type: string;
  encryptedData: string;
  createdAt: number;
  updatedAt: number;
};

export type Session = {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  citations: number[] | null;
  tokensIn: number | null;
  tokensOut: number | null;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  createdAt: number;
};

export type AuditEvent = {
  id: number;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: number;
};
