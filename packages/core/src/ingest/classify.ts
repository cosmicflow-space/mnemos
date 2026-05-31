/**
 * File classification — maps file extensions to (a) a category for the scan
 * UI and (b) the loader id that will handle ingestion.
 *
 * Categories:
 *   - supported   → has a real loader, will be ingested
 *   - deferred    → recognized type, will be supported in a later release
 *                   (e.g. audio/video need local speech-to-text). Surfaced in
 *                   scan UI so the user sees "we know about these" rather than
 *                   "these are garbage."
 *   - unsupported → not recognized; will be ignored entirely
 */

export type FileCategory = "supported" | "deferred" | "unsupported";

export type FileKind =
  | "pdf"
  | "docx"
  | "xlsx"
  | "markdown"
  | "plaintext"
  | "code"
  | "json"
  | "image"
  | "email"
  | "audio"
  | "video"
  | "archive"
  | "binary"
  | "other";

export type Classification = {
  kind: FileKind;
  category: FileCategory;
  /** Loader plugin id (when category === "supported"). */
  loaderId?: string;
  /** Human-readable label for UI display ("PDFs", "markdown files", ...). */
  label: string;
  /** Optional note shown in scan UI (e.g. "audio transcription not yet supported"). */
  note?: string;
};

const EXT_TO_CLASSIFICATION: Record<string, Classification> = {
  // Supported — fully ingested
  ".pdf": { kind: "pdf", category: "supported", loaderId: "pdf", label: "PDFs" },
  ".docx": { kind: "docx", category: "supported", loaderId: "docx", label: "Word documents" },
  ".xlsx": { kind: "xlsx", category: "supported", loaderId: "xlsx", label: "spreadsheets" },
  ".md": { kind: "markdown", category: "supported", loaderId: "markdown", label: "markdown files" },
  ".mdx": { kind: "markdown", category: "supported", loaderId: "markdown", label: "markdown files" },
  ".markdown": { kind: "markdown", category: "supported", loaderId: "markdown", label: "markdown files" },
  ".txt": { kind: "plaintext", category: "supported", loaderId: "plaintext", label: "plaintext" },
  ".log": { kind: "plaintext", category: "supported", loaderId: "plaintext", label: "plaintext" },
  ".csv": { kind: "plaintext", category: "supported", loaderId: "plaintext", label: "plaintext" },
  ".tsv": { kind: "plaintext", category: "supported", loaderId: "plaintext", label: "plaintext" },
  ".json": { kind: "json", category: "supported", loaderId: "plaintext", label: "JSON" },
  ".jsonl": { kind: "json", category: "supported", loaderId: "plaintext", label: "JSON" },
  ".yaml": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".yml": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".toml": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  // Source code
  ".ts": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".tsx": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".js": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".jsx": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".mjs": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".cjs": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".py": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".go": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".rs": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".java": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".kt": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".swift": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".c": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".h": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".cpp": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".rb": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".sh": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".sql": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".html": { kind: "code", category: "supported", loaderId: "code", label: "source code" },
  ".css": { kind: "code", category: "supported", loaderId: "code", label: "source code" },

  // Deferred — recognized but not yet ingested
  ".jpg": { kind: "image", category: "supported", loaderId: "ocr", label: "images" },
  ".jpeg": { kind: "image", category: "supported", loaderId: "ocr", label: "images" },
  ".png": { kind: "image", category: "supported", loaderId: "ocr", label: "images" },
  ".tif": { kind: "image", category: "supported", loaderId: "ocr", label: "images" },
  ".tiff": { kind: "image", category: "supported", loaderId: "ocr", label: "images" },
  ".bmp": { kind: "image", category: "supported", loaderId: "ocr", label: "images" },
  ".webp": { kind: "image", category: "supported", loaderId: "ocr", label: "images" },
  ".gif": { kind: "image", category: "deferred", label: "images", note: "static-image OCR is supported; animated GIFs aren't OCR'd reliably" },
  ".heic": { kind: "image", category: "deferred", label: "images", note: "HEIC OCR coming later (needs HEIF decode)" },
  ".eml": { kind: "email", category: "deferred", label: "email messages", note: "Email ingestion not yet supported" },
  ".mbox": { kind: "email", category: "deferred", label: "email mailboxes", note: "Email ingestion not yet supported" },
  ".mp3": { kind: "audio", category: "deferred", label: "audio files", note: "Transcript support in v0.3" },
  ".m4a": { kind: "audio", category: "deferred", label: "audio files", note: "Transcript support in v0.3" },
  ".wav": { kind: "audio", category: "deferred", label: "audio files", note: "Transcript support in v0.3" },
  ".mp4": { kind: "video", category: "deferred", label: "video files", note: "Transcript support in v0.3" },
  ".mov": { kind: "video", category: "deferred", label: "video files", note: "Transcript support in v0.3" },

  // Unsupported — explicitly recognized as "not for RAG"
  ".zip": { kind: "archive", category: "unsupported", label: "archives" },
  ".tar": { kind: "archive", category: "unsupported", label: "archives" },
  ".gz": { kind: "archive", category: "unsupported", label: "archives" },
  ".7z": { kind: "archive", category: "unsupported", label: "archives" },
  ".rar": { kind: "archive", category: "unsupported", label: "archives" },
  ".dmg": { kind: "binary", category: "unsupported", label: "binaries" },
  ".iso": { kind: "binary", category: "unsupported", label: "binaries" },
  ".exe": { kind: "binary", category: "unsupported", label: "binaries" },
  ".dll": { kind: "binary", category: "unsupported", label: "binaries" },
  ".so": { kind: "binary", category: "unsupported", label: "binaries" },
  ".dylib": { kind: "binary", category: "unsupported", label: "binaries" },
};

const FALLBACK: Classification = {
  kind: "other",
  category: "unsupported",
  label: "other",
};

export function classifyFile(filePath: string): Classification {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return FALLBACK;
  const ext = filePath.slice(idx).toLowerCase();
  return EXT_TO_CLASSIFICATION[ext] ?? FALLBACK;
}

export function listSupportedExtensions(): string[] {
  return Object.entries(EXT_TO_CLASSIFICATION)
    .filter(([, c]) => c.category === "supported")
    .map(([ext]) => ext);
}
