"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";

type VerifiedAnswer = {
  id: number;
  question: string;
  answer: string;
  provider: string | null;
  model: string | null;
  createdAt: number;
};

/** Manage the verified-answer memory: review confirmed Q→A pairs and forget
 * any that are wrong or stale. (Stale answers also self-invalidate at query
 * time when their source chunks change, but explicit removal is here too.) */
export function VerifiedAnswersModal({ onClose }: { onClose: () => void }) {
  const [answers, setAnswers] = useState<VerifiedAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/verified", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as { answers: VerifiedAnswer[] };
        setAnswers(d.answers);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function remove(id: number) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/verified?id=${id}`, { method: "DELETE" });
      if (r.ok) setAnswers((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // silent
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal title="Verified answers" onClose={onClose} maxWidth="max-w-2xl">
      <p className="text-xs text-muted mb-3 leading-relaxed">
        Answers you confirmed as correct. When you ask a closely-matching
        question, the confirmed answer is injected so even small models get it
        right. Remove any that are wrong.
      </p>
      {loading ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : answers.length === 0 ? (
        <p className="text-xs text-muted">
          None yet — click <span className="text-emerald-400">✓ Save verified</span>{" "}
          on a correct answer to add one.
        </p>
      ) : (
        <ul className="space-y-2">
          {answers.map((a) => (
            <li key={a.id} className="rounded-md border border-line bg-surface px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-fg truncate" title={a.question}>
                    Q: {a.question}
                  </div>
                  <div className="text-xs text-muted mt-0.5 line-clamp-2" title={a.answer}>
                    A: {a.answer}
                  </div>
                  <div className="text-[10px] text-muted/70 mt-1">
                    {a.model ?? a.provider ?? "unknown model"}
                  </div>
                </div>
                <button
                  onClick={() => void remove(a.id)}
                  disabled={busyId === a.id}
                  className="text-[11px] text-muted hover:text-red-400 transition shrink-0 disabled:opacity-50"
                  title="Forget this verified answer"
                >
                  {busyId === a.id ? "…" : "Forget"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
