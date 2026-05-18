import type { Metadata } from "next";
import "./globals.css";
import { AgentBanner } from "@/components/AgentBanner";

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
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#0a0a14] text-white antialiased">
        <AgentBanner />
        {children}
      </body>
    </html>
  );
}
