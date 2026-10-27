// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// WebAuthn helpers: RP config + a short-lived challenge store.
//
// Challenges are kept in-process and keyed by an opaque token returned to the
// client (and round-tripped via httpOnly signed cookie). They expire after
// CHALLENGE_TTL_MS so abandoned flows are cleaned up. A server restart clears
// pending challenges — acceptable for single-user self-hosted use.

import crypto from 'crypto';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface ChallengeEntry {
  expires: number;
  [key: string]: unknown;
}

const challenges = new Map<string, ChallengeEntry>();

function purge(): void {
  const now = Date.now();
  for (const [token, entry] of challenges) {
    if (entry.expires <= now) challenges.delete(token);
  }
}

export function rpConfig(): { rpID: string; rpName: string; expectedOrigin: string[] } {
  // RP ID must match the effective domain the browser sees. Defaults work for
  // the local-dev hostname the user configured in /etc/hosts.
  const rpID = process.env.WEBAUTHN_RP_ID || 'irc.local.bradroot.me';
  const rpName = process.env.WEBAUTHN_RP_NAME || 'Lurker';
  const rawOrigins = process.env.WEBAUTHN_ORIGIN || 'https://irc.local.bradroot.me:5173';
  const expectedOrigin = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { rpID, rpName, expectedOrigin };
}

export function saveChallenge(payload: Record<string, unknown>): string {
  purge();
  const token = crypto.randomBytes(32).toString('base64url');
  challenges.set(token, { ...payload, expires: Date.now() + CHALLENGE_TTL_MS });
  return token;
}

/** Whether any unexpired challenge was saved for `purpose` — a ceremony that
 *  may still complete. */
export function hasLiveChallenge(purpose: string): boolean {
  purge();
  for (const entry of challenges.values()) {
    if (entry.purpose === purpose) return true;
  }
  return false;
}

export function consumeChallenge(token: string | null | undefined): ChallengeEntry | null {
  if (!token) return null;
  purge();
  const entry = challenges.get(token);
  if (!entry) return null;
  challenges.delete(token);
  if (entry.expires <= Date.now()) return null;
  return entry;
}

// WebAuthn user handles must be 1-64 bytes of opaque binary. We derive one
// deterministically from the integer user id so the same user always gets the
// same handle (required for credential discovery & cross-device sync).
// The `caint-` prefix is frozen — these bytes live on enrolled authenticators
// (TouchID/security keys) and cannot be rotated without re-registering passkeys.
export function userIdToHandle(userId: number): Buffer {
  return Buffer.from(`caint-user-${userId}`, 'utf8');
}

export function handleToUserId(handle: Uint8Array | Buffer): number | null {
  const s = Buffer.from(handle).toString('utf8');
  const m = /^caint-user-(\d+)$/.exec(s);
  return m ? Number(m[1]) : null;
}
