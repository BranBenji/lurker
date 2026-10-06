// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The admin's opt-in to push.lurker.chat (lurker-dev/RELAY_PLAN.md §5a).
//
// The relay is a Web Push push service for the official iOS and Android apps,
// which can't receive native push from a server that doesn't hold our APNs/FCM
// keys. Nothing about SENDING changes: a relay subscription is an ordinary Web
// Push row and goes out through webpushSender like a browser's. What this module
// adds is consent. Until the admin turns the relay on, /api/push/config doesn't
// mention it — so the apps never contact it — and the server neither files nor
// sends to a relay endpoint.

import db from '../../db/index.js';
import { pushRelayEnabled, setPushRelayEnabled } from '../../db/instanceSettings.js';
import { countWebPushWhere, deleteWebPushWhere } from '../../db/pushSubscriptions.js';

const DEFAULT_RELAY_URL = 'https://push.lurker.chat';

// The override exists for developing the relay against a local server. Only the
// origin is kept: the apps build their endpoint paths themselves, and endpoints
// are matched on scheme, host and port.
function parseRelayUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LURKER_PUSH_RELAY_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`LURKER_PUSH_RELAY_URL must be http(s): ${raw}`);
  }
  return url;
}

// Not URL.origin: that keeps a trailing dot, and `push.lurker.chat.` is the same
// host to DNS and TLS. Comparing origins would let such an endpoint past the
// opt-in and on to the relay.
function hostKey(url: URL): string {
  return `${url.protocol}//${url.hostname.replace(/\.+$/, '')}:${url.port}`;
}

const relayUrl = parseRelayUrl(process.env.LURKER_PUSH_RELAY_URL || DEFAULT_RELAY_URL);
export const RELAY_ORIGIN = relayUrl.origin;
const RELAY_HOST_KEY = hostKey(relayUrl);

export function isRelayEndpoint(endpoint: string): boolean {
  try {
    return hostKey(new URL(endpoint)) === RELAY_HOST_KEY;
  } catch {
    return false;
  }
}

/**
 * May this server file, or send to, a subscription at `endpoint`? Everything but
 * the relay always may; the relay only while the admin has it on.
 */
export function relayAllows(endpoint: string): boolean {
  return !isRelayEndpoint(endpoint) || pushRelayEnabled();
}

/** The relay's URL while the admin has it on, else null. */
export function advertisedRelay(): string | null {
  return pushRelayEnabled() ? RELAY_ORIGIN : null;
}

/** Devices currently getting pushes through the relay (disabled rows don't). */
export function relayDeviceCount(): number {
  return countWebPushWhere(isRelayEndpoint);
}

/**
 * Turn the relay on or off. Off deletes every relay subscription, across all
 * users: the opt-out has to stop the server sending to the relay, not just stop
 * new apps from finding it. Returns how many were deleted.
 */
export function setRelayEnabled(enabled: boolean): number {
  // One transaction: a failed delete must not leave the switch off with relay
  // rows still filed.
  return db.transaction(() => {
    setPushRelayEnabled(enabled);
    return enabled ? 0 : deleteWebPushWhere(isRelayEndpoint);
  })();
}
