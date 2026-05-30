"use client";

import { type ReactNode } from "react";
import { Modal } from "@/components/Modal";

/** Elegant confirmation dialog — replaces the browser's native confirm().
 * Backdrop/Escape cancel (via Modal); the confirm action can be styled as a
 * destructive (danger) red button. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} maxWidth="max-w-sm">
      <div className="text-sm text-muted leading-relaxed mb-4">{message}</div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs text-muted hover:text-fg hover:bg-surface transition"
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          autoFocus
          className={`rounded-md px-4 py-1.5 text-xs font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${
            danger
              ? "bg-red-500 text-white hover:bg-red-400"
              : "bg-cyan-500 text-gray-900 hover:bg-cyan-400"
          }`}
        >
          {busy ? "…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
