// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The admin's opt-in to push.lurker.chat (lurker-dev/RELAY_PLAN.md §5a).
//
// The relay is a Web Push push service for the official iOS and Android apps,
// which can't receive native push from a server that doesn't hold our APNs/FCM
// keys. Nothing about SENDING changes: a relay subscription is an ordinary Web
// Push row and goes out through webpushSender like a browser's. What this module
// adds is consent. Until the admin turns the relay on, /api/push/config doesn't
// mention it — so the apps never contact it — and the server refuses relay
// endpoints, so it never sends there either.

import { pushRelayEnabled, setPushRelayEnabled } from '../../db/instanceSettings.js';
import { countWebPushWhere, deleteWebPushWhere } from '../../db/pushSubscriptions.js';

const DEFAULT_RELAY_URL = 'https://push.lurker.chat';

// The override exists for developing the relay against a local server. Only the
// origin is kept: the apps build their endpoint paths themselves, and the
// registration check matches on origin.
function parseRelayOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LURKER_PUSH_RELAY_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`LURKER_PUSH_RELAY_URL must be http(s): ${raw}`);
  }
  return url.origin;
}

export const RELAY_ORIGIN = parseRelayOrigin(
  process.env.LURKER_PUSH_RELAY_URL || DEFAULT_RELAY_URL,
);

export function isRelayEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).origin === RELAY_ORIGIN;
  } catch {
    return false;
  }
}

/** The relay's URL while the admin has it on, else null. */
export function advertisedRelay(): string | null {
  return pushRelayEnabled() ? RELAY_ORIGIN : null;
}

export function relayDeviceCount(): number {
  return countWebPushWhere(isRelayEndpoint);
}

/**
 * Turn the relay on or off. Off deletes every relay subscription, across all
 * users: the opt-out has to stop the server sending to the relay, not just stop
 * new apps from finding it. Returns how many were deleted.
 */
export function setRelayEnabled(enabled: boolean): number {
  setPushRelayEnabled(enabled);
  return enabled ? 0 : deleteWebPushWhere(isRelayEndpoint);
}
