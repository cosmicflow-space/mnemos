/**
 * The Mnemos wordmark — the single source of truth for the brand name in the UI.
 *
 * Treatment (V3+V7): two-tone letters — cyan "Mnem" (retrieval) + amber "s"
 * (memory) — with the "o" replaced by a neuron glyph (cyan ring, amber core,
 * synapse dots) echoing the logo mark's palette. Font size and weight are
 * inherited from the parent, and the neuron is em-sized, so the same component
 * reads correctly in a 14px header and a 48px hero alike. Always pair it with
 * the `/logo.svg` mark for the full lockup.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Mnemos"
      className={`inline-flex items-center tracking-tight ${className}`}
    >
      <span className="text-cyan-500">Mnem</span>
      <svg
        viewBox="0 0 32 32"
        aria-hidden="true"
        style={{ width: "0.82em", height: "0.82em", margin: "0 0.02em" }}
        className="inline-block shrink-0"
      >
        <circle cx="16" cy="16" r="9" fill="none" stroke="#06b6d4" strokeWidth="3" />
        <circle cx="16" cy="16" r="3.2" fill="#f59e0b" />
        <g stroke="#06b6d4" strokeWidth="2" strokeLinecap="round">
          <path d="M16 7V3" />
          <path d="M16 25v4" />
          <path d="M7 16H3" />
          <path d="M25 16h4" />
        </g>
        <g fill="#f59e0b">
          <circle cx="16" cy="3" r="1.6" />
          <circle cx="16" cy="29" r="1.6" />
          <circle cx="3" cy="16" r="1.6" />
          <circle cx="29" cy="16" r="1.6" />
        </g>
      </svg>
      <span className="text-amber-500">s</span>
    </span>
  );
}
