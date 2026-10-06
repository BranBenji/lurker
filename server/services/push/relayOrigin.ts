// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which endpoints are push.lurker.chat (lurker-dev/RELAY_PLAN.md §5a). Imports
// nothing, so both the opt-in (relay.ts) and the database layer can use it.

const DEFAULT_RELAY_URL = 'https://push.lurker.chat';

// The override exists for developing the relay against a local server. Only the
// origin is kept: the apps build their endpoint paths themselves. https only,
// because web-push sends every endpoint over https whatever its scheme says.
function parseRelayUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LURKER_PUSH_RELAY_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`LURKER_PUSH_RELAY_URL must be https: ${raw}`);
  }
  return url;
}

// Endpoints are matched on host alone. web-push sends every endpoint with
// https.request, so `http://push.lurker.chat/…` or any port on that host still
// reaches the relay. The trailing dot goes too: URL keeps it, but it's the same
// host to DNS and TLS.
function bareHost(url: URL): string {
  return url.hostname.replace(/\.+$/, '');
}

const relayUrl = parseRelayUrl(process.env.LURKER_PUSH_RELAY_URL || DEFAULT_RELAY_URL);
export const RELAY_ORIGIN = relayUrl.origin;
// The official relay stays covered under an override, so rows filed before it
// was set don't slip out from under the opt-in.
const RELAY_HOSTS = new Set([bareHost(new URL(DEFAULT_RELAY_URL)), bareHost(relayUrl)]);

export function isRelayEndpoint(endpoint: string): boolean {
  try {
    return RELAY_HOSTS.has(bareHost(new URL(endpoint)));
  } catch {
    return false;
  }
}

/**
 * A relay endpoint that names a phone: `/relay-to/{apns|fcm}/…` carries its
 * APNs/FCM token (lurker-dev/RELAY_PLAN.md §6.2), so it's the same URL whichever
 * account the phone is signed in as. Anything else on the relay host doesn't
 * name an install, and keeps the browser rule.
 */
export function namesRelayDevice(endpoint: string): boolean {
  if (!isRelayEndpoint(endpoint)) return false;
  try {
    return /^\/relay-to\/(apns|fcm)\//.test(new URL(endpoint).pathname);
  } catch {
    return false;
  }
}
