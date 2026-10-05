// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Web Push over the seam (#490 phase 3).
//
// This is the pre-existing behavior moved, not rewritten — the classify() rules
// below are the exact status checks deliver() used to make inline, and their
// reasoning is preserved with them. It's also the transport the other two are
// measured against: it went first through the seam precisely to check the seam
// could hold something real.

import crypto from 'crypto';
import webpush from 'web-push';
import type { PushSubscription } from '../../db/pushSubscriptions.js';
import {
  PUSH_TTL_SECONDS,
  pushBody,
  type NotificationContent,
  type PushPayload,
} from '../notificationContent.js';
import type { FailureClass, PushSender } from './types.js';

interface WebPushErrorish {
  statusCode?: number;
  message?: string;
  body?: string;
}

// The body is identical for every one of a user's browsers, but send() is called
// once per subscription — so serializing inside it would rebuild the same string
// per device, where the pre-seam code hoisted one `const json` above the fan-out.
//
// deliver() composes `content` exactly once per push and hands that same object
// to every subscription, so keying on its identity collapses the work back to
// one serialization. A WeakMap because the entry should die with the push, not
// accumulate one string per notification ever sent.
const bodyCache = new WeakMap<NotificationContent, string>();

function webpushBody(payload: PushPayload, content: NotificationContent): string {
  const cached = bodyCache.get(content);
  if (cached !== undefined) return cached;
  const body = JSON.stringify(pushBody(payload, content));
  bodyCache.set(content, body);
  return body;
}

/**
 * The Web Push `Topic` for a collapse tag (RFC 8030 §5.4): a push service holding
 * an undelivered push replaces it with a newer one on the same topic, so a phone
 * that was off gets the buffer's latest rather than a queue of them — what the tag
 * already does to notifications on screen. A topic is at most 32 characters of the
 * URL-safe base64 alphabet, and a tag (`7::#lurker`) is neither, so it's hashed.
 * A relay maps it to the APNs collapse id / FCM collapse key (#1045).
 */
export function webpushTopic(tag: string): string {
  return crypto.createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

/**
 * The delivery policy every Web Push goes out with. `high` urgency because a chat
 * message is wanted now: at `normal`, a push service may hold it for a sleeping
 * phone (Android's Doze, on FCM's Web Push endpoint), and a relay reads urgency as
 * APNs/FCM priority.
 */
export function webpushOptions(content: NotificationContent): webpush.RequestOptions {
  return { TTL: PUSH_TTL_SECONDS, urgency: 'high', topic: webpushTopic(content.tag) };
}

export const webpushSender: PushSender = {
  transport: 'webpush',

  // VAPID keys are generated on demand and stored in app_meta, so Web Push is
  // always configured — unlike the native transports, it needs nothing from the
  // operator.
  isConfigured: () => true,
  configHint: () => '',

  async send(
    sub: PushSubscription,
    payload: PushPayload,
    content: NotificationContent,
  ): Promise<void> {
    if (sub.transport !== 'webpush') {
      // Unreachable: pushService dispatches by sub.transport. Narrows the union
      // so p256dh/auth are known present, and states the invariant out loud.
      throw new Error(`webpushSender received a ${sub.transport} subscription`);
    }
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      webpushBody(payload, content),
      webpushOptions(content),
    );
  },

  classify(err: unknown): FailureClass {
    const status = (err as WebPushErrorish)?.statusCode;
    // The push service says this endpoint is gone for good.
    if (status === 404 || status === 410) return 'permanent';
    // Rate limits (429), server errors (5xx), and transport-level errors with no
    // statusCode (DNS/connect blips, timeouts) are the network or the service
    // having a bad moment — not a dead subscription. Otherwise a short outage
    // during a burst of notifications could disable a healthy endpoint.
    if (status == null || status === 429 || status >= 500) return 'transient';
    // A concrete 4xx (auth rejects, malformed requests, gone-but-not-404/410).
    return 'strike';
  },

  describe(err: unknown): string {
    const e = err as WebPushErrorish;
    const body = typeof e?.body === 'string' ? e.body.slice(0, 500) : '';
    return `status=${e?.statusCode ?? '?'} message=${e?.message || String(err)} body=${body}`;
  },
};
