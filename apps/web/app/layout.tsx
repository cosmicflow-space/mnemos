import type { Metadata } from "next";
import "./globals.css";

// No-FOUC theme bootstrap. Static, developer-authored, zero user input — the
// standard Next.js pattern for applying the persisted theme before first paint.
// Defaults to dark when no choice is stored.
const themeInit = `(function(){try{var t=localStorage.getItem('mnemos.theme');var d=document.documentElement;if(t==='light'){d.classList.add('light');d.classList.remove('dark');}else{d.classList.add('dark');d.classList.remove('light');}}catch(e){document.documentElement.classList.add('dark');}})();`;

export const metadata: Metadata = {
  title: "Mnemos — Personal RAG",
  description: "Drop a folder, ask a question. Local-first personal RAG.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: { url: "/logo.svg", type: "image/svg+xml" },
  },
  openGraph: {
    title: "Mnemos — Personal RAG",
    description: "Drop a folder, ask a question. Local-first personal RAG.",
    images: ["/logo.svg"],
  },
  twitter: {
    card: "summary",
    title: "Mnemos — Personal RAG",
    description: "Drop a folder, ask a question. Local-first personal RAG.",
    images: ["/logo.svg"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-screen bg-app text-fg antialiased">
        {children}
      </body>
    </html>
  );
}
