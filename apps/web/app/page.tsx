export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="max-w-2xl text-center space-y-6">
        <div className="text-7xl">🧠</div>
        <h1 className="text-5xl font-bold tracking-tight bg-gradient-to-r from-cyan-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
          Mnemos
        </h1>
        <p className="text-xl text-gray-300">
          Personal RAG. Local-first. Drop a folder, ask a question.
        </p>
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-6 text-left">
          <p className="text-sm text-gray-400 mb-2">v0.1 scaffold — UI shell only</p>
          <p className="text-base">
            The three-pane interface (folders / chat / inspector) lands in the next build pass. For now this confirms the Next.js app boots, Tailwind renders, and the runtime is wired correctly.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
          <a
            href="/api/health"
            className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium hover:bg-cyan-400 transition"
          >
            Check health endpoint
          </a>
          <a
            href="https://github.com/sammuthu/mnemos"
            className="rounded-md border border-gray-700 px-4 py-2 text-sm font-medium hover:border-gray-600 transition"
          >
            View source on GitHub
          </a>
        </div>
      </div>
    </main>
  );
}
