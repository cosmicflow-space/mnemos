/**
 * Web-side session helpers mirroring the Telegram poller's freshSession: a focus
 * transition opens a brand-new thread so the new scope can't leak the prior
 * file's discussion. The new session id is returned to the client, which adopts
 * it (clears the visible thread, scopes subsequent questions).
 */

import { randomUUID } from "node:crypto";
import { createSession } from "@mnemos/db";
import { getDb } from "./runtime";

/** Create a fresh, untitled session and return its id (titled lazily by the
 * first question, exactly like any other web/Telegram session). */
export function freshSession(): string {
  const id = randomUUID();
  createSession(getDb(), id);
  return id;
}
