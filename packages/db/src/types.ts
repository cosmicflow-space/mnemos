export type SourceKind = "folder" | "url" | "mailbox";

export type Source = {
  id: number;
  path: string;
  kind: SourceKind;
  scope: "read-only";
  createdAt: number;
  updatedAt: number;
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
