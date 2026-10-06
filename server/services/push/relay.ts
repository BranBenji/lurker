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

// Matching lives in relayOrigin.ts, which imports nothing, so the database layer
// can ask "is this a relay endpoint?" without a cycle back through here.
import { RELAY_ORIGIN, isRelayEndpoint } from './relayOrigin.js';

export { RELAY_ORIGIN, isRelayEndpoint };

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
