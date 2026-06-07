/**
 * The `/do` write guard — a PIN that proves a human is present (DO.md §6).
 *
 * The PIN is never a defense against offline cracking; it is a secret the model
 * cannot produce. The human types it out-of-band; a prompt-injected or automated
 * caller hits the gate and cannot answer it. Stored hashed (scrypt — a built-in
 * KDF, no new dependency) at `~/.mnemos/.pin.json`, chmod 600, never in clear.
 *
 * A successful entry opens a cadence window (default daily); within it, writes
 * proceed without re-asking. An anomaly (decided by the caller — e.g. a bulk add)
 * forces a PIN regardless. Repeated failures lock out for a cooling-off period.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PIN_PATH = path.join(os.homedir(), ".mnemos", ".pin.json");

export type Cadence = "each-time" | "hourly" | "daily" | "weekly";
const WINDOW_MS: Record<Cadence, number> = {
  "each-time": 0,
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

type ScryptParams = { N: number; r: number; p: number };
// Strong cost for a local secret: ~128 MB, ~100ms — imperceptible for a 6-digit
// human entry, materially harder to brute-force `.pin.json` offline.
const SCRYPT: ScryptParams = { N: 131072, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
// Node's legacy default (used by PINs set before params were stored), so an
// existing `.pin.json` keeps verifying after this upgrade.
const LEGACY_SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1 };

type PinFile = {
  salt: string;
  hash: string;
  cadence: Cadence;
  lastVerifiedAt: number;
  failedAttempts: number;
  lockedUntil: number;
  params?: ScryptParams;
};

function load(): PinFile | null {
  try {
    return JSON.parse(readFileSync(PIN_PATH, "utf8")) as PinFile;
  } catch {
    return null;
  }
}

function save(p: PinFile): void {
  writeFileSync(PIN_PATH, JSON.stringify(p, null, 2), { mode: 0o600 });
  try {
    chmodSync(PIN_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

function hashPin(digits: string, salt: string, params: ScryptParams = LEGACY_SCRYPT): Buffer {
  return scryptSync(digits, salt, 64, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
}

export function pinExists(): boolean {
  return load() !== null;
}

export function setPin(digits: string, cadence: Cadence = "daily"): void {
  const salt = randomBytes(16).toString("hex");
  save({
    salt,
    hash: hashPin(digits, salt, SCRYPT).toString("hex"),
    params: SCRYPT,
    cadence,
    // Setting the PIN is itself a human action proving presence, so open the
    // cadence window now — the next add just works (no confusing immediate re-ask).
    lastVerifiedAt: Date.now(),
    failedAttempts: 0,
    lockedUntil: 0,
  });
}

export function getCadence(): Cadence {
  return load()?.cadence ?? "daily";
}

/** Remaining lockout in ms (0 if not locked). */
export function lockedMs(): number {
  const p = load();
  if (!p) return 0;
  return p.lockedUntil > Date.now() ? p.lockedUntil - Date.now() : 0;
}

/** True if a prior successful PIN still covers the cadence window. */
export function windowValid(): boolean {
  const p = load();
  if (!p) return false;
  const w = WINDOW_MS[p.cadence];
  if (w === 0) return false; // each-time always re-auths
  return Date.now() - p.lastVerifiedAt < w;
}

export type VerifyResult = { ok: true } | { ok: false; lockedMs?: number; attemptsLeft?: number };

export function verify(digits: string): VerifyResult {
  const p = load();
  if (!p) return { ok: false };
  if (p.lockedUntil > Date.now()) return { ok: false, lockedMs: p.lockedUntil - Date.now() };

  const expected = Buffer.from(p.hash, "hex");
  const actual = hashPin(digits, p.salt, p.params);
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (ok) {
    p.failedAttempts = 0;
    p.lockedUntil = 0;
    p.lastVerifiedAt = Date.now();
    save(p);
    return { ok: true };
  }

  p.failedAttempts += 1;
  if (p.failedAttempts >= MAX_FAILS) {
    p.lockedUntil = Date.now() + LOCK_MS;
    p.failedAttempts = 0;
    save(p);
    return { ok: false, lockedMs: LOCK_MS };
  }
  save(p);
  return { ok: false, attemptsLeft: MAX_FAILS - p.failedAttempts };
}
