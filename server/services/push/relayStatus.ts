// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Asks push.lurker.chat whether this server's key is active there
// (lurker-dev/RELAY_PLAN.md §6.5). Signed with the server's own VAPID key, the
// same proof a push carries, so the relay knows whose status it's answering.
//
// Only ever called once the admin has opted in, or when they ask for it: the
// opt-in (§5a) means this server doesn't contact the relay on its own.

import webpush from 'web-push';
import { vapidCredentials } from '../pushService.js';
import { RELAY_ORIGIN } from './relayOrigin.js';

export type RelayStatus =
  | { state: 'active'; comped: boolean; paidThrough: string | null }
  | { state: 'inactive'; registered: boolean }
  | { state: 'unauthorized' }
  | { state: 'unreachable'; reason: string };

const TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;

let cached: { at: number; status: RelayStatus } | null = null;

export function resetRelayStatusCache(): void {
  cached = null;
}

async function fetchStatus(timeoutMs: number): Promise<RelayStatus> {
  const { subject, publicKey, privateKey } = vapidCredentials();
  const { Authorization } = webpush.getVapidHeaders(
    RELAY_ORIGIN,
    subject,
    publicKey,
    privateKey,
    'aes128gcm',
  ) as { Authorization: string };
  let res: Response;
  try {
    res = await fetch(`${RELAY_ORIGIN}/status`, {
      headers: { Authorization },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { state: 'unreachable', reason: (err as Error)?.message || String(err) };
  }
  if (res.status === 401) return { state: 'unauthorized' };
  if (!res.ok) return { state: 'unreachable', reason: `status ${res.status}` };
  let body: { registered?: unknown; active?: unknown; comped?: unknown; paidThrough?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { state: 'unreachable', reason: 'unparseable answer' };
  }
  if (typeof body?.active !== 'boolean') {
    return { state: 'unreachable', reason: 'unparseable answer' };
  }
  if (body.active) {
    return {
      state: 'active',
      comped: body.comped === true,
      paidThrough: typeof body.paidThrough === 'string' ? body.paidThrough : null,
    };
  }
  return { state: 'inactive', registered: body.registered === true };
}

/**
 * The relay's answer for this server's key. Cached for a minute so the admin pane
 * doesn't ask on every load; `fresh` (turning the relay on, or the admin's
 * "check") always asks.
 */
export async function relayStatus(
  opts: { fresh?: boolean; timeoutMs?: number; now?: number } = {},
): Promise<RelayStatus> {
  const now = opts.now ?? Date.now();
  if (!opts.fresh && cached && now - cached.at < CACHE_MS) return cached.status;
  const status = await fetchStatus(opts.timeoutMs ?? TIMEOUT_MS);
  cached = { at: now, status };
  return status;
}
