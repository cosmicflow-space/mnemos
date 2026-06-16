import Image from "next/image";
import { Wordmark } from "@/components/Wordmark";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="max-w-2xl text-center space-y-6">
        <Image
          src="/logo.svg"
          alt="Mnemos"
          width={128}
          height={128}
          priority
          unoptimized
          className="mx-auto"
        />
        <h1 className="text-5xl font-bold flex justify-center">
          <Wordmark />
        </h1>
        <p className="text-xl text-muted">
          Personal RAG. Local-first. Drop a folder, ask a question.
        </p>
        <div className="rounded-lg border border-line bg-surface p-6 text-left aurora-card">
          <p className="text-sm text-muted mb-2">Local-first personal RAG · MIT</p>
          <p className="text-base text-fg/90">
            Drop a folder or a single file, then ask questions and get answers cited to your own sources — 100% local by default, with a private Telegram channel to ask from your phone. Configure a model, add a source, and start chatting below.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
          <a
            href="/agent"
            className="rounded-md bg-amber-500 px-5 py-2.5 text-sm font-semibold text-gray-900 hover:bg-amber-400 transition"
          >
            Configure Agent →
          </a>
          <a
            href="/chat"
            className="rounded-md border border-cyan-600/60 dark:border-cyan-700 bg-cyan-500/10 px-5 py-2.5 text-sm font-semibold text-cyan-700 dark:text-cyan-200 hover:bg-cyan-500/20 transition"
          >
            Start Chat
          </a>
          <a
            href="/sources"
            className="rounded-md border border-cyan-600/60 dark:border-cyan-700 bg-cyan-500/10 px-5 py-2.5 text-sm font-semibold text-cyan-700 dark:text-cyan-200 hover:bg-cyan-500/20 transition"
          >
            Manage Sources
          </a>
          <a
            href="https://github.com/cosmicflow-space/mnemos"
            className="rounded-md border border-line px-4 py-2 text-sm font-medium text-fg hover:border-line-strong transition"
          >
            GitHub
          </a>
        </div>
      </div>
    </main>
  );
}
