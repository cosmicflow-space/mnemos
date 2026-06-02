import Link from "next/link";
import type { Metadata } from "next";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const metadata: Metadata = {
  title: "Mnemos · Telegram setup guide",
  description: "Step-by-step: create a Telegram bot and ask your Mnemos from your phone.",
};

/**
 * Standalone, no-auth onboarding guide for users new to Telegram bots. Linked
 * from Settings → Telegram (opens in a new tab). Text + step cards + links to
 * Telegram's official tutorial — no third-party screenshots bundled (licensing).
 * Drop your own screenshots into /public/guide/telegram/step-N.png and they'll
 * appear in the matching step (the <Shot> slot renders nothing if absent).
 */

function Step({
  n,
  title,
  children,
  shot,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  shot?: string;
}) {
  return (
    <li className="relative pl-12 pb-8 border-l border-line last:border-l-transparent">
      <span className="absolute -left-4 top-0 w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500/30 to-indigo-500/30 border border-cyan-600/60 text-fg flex items-center justify-center text-sm font-semibold">
        {n}
      </span>
      <h3 className="text-base font-semibold text-fg mb-1">{title}</h3>
      <div className="text-sm text-muted leading-relaxed space-y-2">{children}</div>
      {shot && <Shot src={shot} />}
    </li>
  );
}

/** Renders a screenshot ONLY if the operator dropped one in
 * apps/web/public/guide/telegram/. Checked server-side so a missing file simply
 * renders nothing (no broken-image icons, no client JS). Add your own
 * screenshots there to illustrate the steps — they're license-clean. */
function Shot({ src }: { src: string }) {
  if (!existsSync(join(process.cwd(), "public", src))) return null;
  return (
    <div className="mt-3 rounded-lg border border-line overflow-hidden max-w-xs bg-surface">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="w-full h-auto block" />
    </div>
  );
}

function Cmd({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-surface border border-line text-cyan-300 font-mono text-[0.85em]">
      {children}
    </code>
  );
}

export default function TelegramGuidePage() {
  return (
    <main className="min-h-screen bg-app text-fg">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <Link href="/chat" className="text-xs text-cyan-400 hover:text-cyan-300">
          ← Back to Mnemos
        </Link>

        <h1 className="text-2xl font-bold mt-4 mb-1">Ask Mnemos from your phone</h1>
        <p className="text-sm text-muted mb-6 leading-relaxed">
          You&apos;ll create a private Telegram bot and pair it with your Mnemos. Then you can
          message it like a contact and get answers from your own documents — your files never
          leave your computer; only the question and answer pass through Telegram. The whole
          setup takes about 3 minutes, even if you&apos;ve never made a bot before.
        </p>

        <div className="rounded-lg border border-cyan-700/40 bg-cyan-500/5 px-4 py-3 mb-8 text-sm text-muted">
          <strong className="text-fg">Prefer Telegram&apos;s own walkthrough?</strong> Their
          official, illustrated tutorial is here:{" "}
          <a
            href="https://core.telegram.org/bots/tutorial"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:text-cyan-300 underline"
          >
            core.telegram.org/bots/tutorial ↗
          </a>
          . The steps below are the short version, tailored to Mnemos.
        </div>

        <ol className="list-none">
          <Step n={1} title="Install Telegram" shot="/guide/telegram/step-1.png">
            <p>
              Get the Telegram app on your phone (App Store / Google Play) or desktop, and create
              an account with your phone number. If you already use Telegram, skip this.
            </p>
          </Step>

          <Step n={2} title="Open BotFather" shot="/guide/telegram/step-2.png">
            <p>
              In Telegram, tap the <strong>search</strong> (🔍) and type{" "}
              <Cmd>BotFather</Cmd>. Open the official one — the name has a{" "}
              <strong>blue verified check</strong>. BotFather is Telegram&apos;s tool for making
              bots.
            </p>
          </Step>

          <Step n={3} title="Create your bot" shot="/guide/telegram/step-3.png">
            <p>
              Send <Cmd>/newbot</Cmd>. BotFather asks for:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                a <strong>name</strong> (anything, e.g. <em>My Mnemos</em>)
              </li>
              <li>
                a <strong>username</strong> that must end in <Cmd>bot</Cmd> (e.g.{" "}
                <Cmd>my_mnemos_bot</Cmd>) and be unique
              </li>
            </ul>
            <p>
              BotFather replies with a <strong>token</strong> — a long secret like{" "}
              <Cmd>123456:ABC-DEF…</Cmd>.{" "}
              <strong className="text-fg">
                Treat it like a password — don&apos;t paste it into any chat or email.
              </strong>
            </p>
          </Step>

          <Step n={4} title="Give Mnemos the token" shot="/guide/telegram/step-4.png">
            <p>
              Back in Mnemos: bottom-left <strong>settings avatar</strong> →{" "}
              <strong>📲 Telegram</strong>. Paste the token and click{" "}
              <strong>Verify &amp; save</strong>. Mnemos checks it with Telegram and stores it
              locally on your machine (in <Cmd>~/.mnemos/.env</Cmd>) — never online.
            </p>
          </Step>

          <Step n={5} title="Enable + get a pairing code" shot="/guide/telegram/step-5.png">
            <p>
              Turn on <strong>Enable the Telegram bot</strong>, then click{" "}
              <strong>Generate pairing code</strong>. You&apos;ll get an 8-character code that&apos;s
              good for 10 minutes and works once.
            </p>
          </Step>

          <Step n={6} title="Open your bot" shot="/guide/telegram/step-6.png">
            <p>
              Your new bot won&apos;t appear in your chat list until you open it once. In Telegram,
              search your bot&apos;s <strong>exact username</strong> (the one ending in{" "}
              <Cmd>bot</Cmd>), open it, and tap <strong>Start</strong>. It&apos;ll reply that it&apos;s
              private — that&apos;s expected and means it&apos;s connected to your Mnemos.
            </p>
          </Step>

          <Step n={7} title="Pair it" shot="/guide/telegram/step-7.png">
            <p>
              Send <Cmd>/pair</Cmd> followed by your code, e.g. <Cmd>/pair AB12CD34</Cmd>. You&apos;ll
              get <strong>✅ Paired</strong>. Now only your phone can talk to this bot.
            </p>
          </Step>

          <Step n={8} title="Ask anything">
            <p>
              Just message the bot a question about your documents — like{" "}
              <em>&quot;what are the Land Rover supplies?&quot;</em> — and you&apos;ll get an answer
              with sources, generated on your computer. That&apos;s it. 🎉
            </p>
            <p className="mt-2">
              <strong className="text-fg">Smart routing</strong> — prefix a message to choose how
              it&apos;s answered: <Cmd>!</Cmd> asks the model directly (skips your files);{" "}
              <Cmd>!!</Cmd> asks a frontier model directly; <Cmd>+</Cmd> searches your files but
              answers with a frontier model (<Cmd>!!!</Cmd>/<Cmd>++</Cmd> use the top frontier
              model). No prefix = your files + the local model. Frontier prefixes need an API key
              configured in Mnemos; the bot will tell you if one&apos;s missing. Every reply is
              labeled so you always know whether your files were searched and which model answered.
              Send <Cmd>/tips</Cmd> anytime to see this cheatsheet.
            </p>
          </Step>
        </ol>

        <h2 className="text-lg font-semibold mt-4 mb-2">Good to know</h2>
        <ul className="list-disc pl-5 text-sm text-muted space-y-1.5 leading-relaxed">
          <li>
            <strong className="text-fg">Your computer must be awake</strong> with Mnemos running
            for the bot to answer. If it&apos;s asleep, your message waits and is answered when it
            wakes.
          </li>
          <li>
            <strong className="text-fg">Direct messages only.</strong> The bot won&apos;t work in
            groups — that keeps your documents private to you.
          </li>
          <li>
            <strong className="text-fg">Privacy.</strong> Your files stay on your machine. Your
            question and the answer travel through Telegram (and whichever AI model you&apos;ve
            configured), so treat it like any other messaging app.
          </li>
          <li>
            <strong className="text-fg">Pairing code expired?</strong> Just generate a fresh one
            in Settings → Telegram and send <Cmd>/pair</Cmd> again.
          </li>
          <li>
            <strong className="text-fg">Want better answers?</strong> Pick a larger local model
            or a cloud model in <strong>AI Model</strong> settings — the bot uses whatever you
            choose.
          </li>
        </ul>

        <div className="mt-10 text-center">
          <Link
            href="/chat"
            className="inline-block rounded-md bg-cyan-500 px-5 py-2 text-sm font-semibold text-gray-900 hover:bg-cyan-400 transition"
          >
            Back to Mnemos
          </Link>
        </div>
      </div>
    </main>
  );
}
