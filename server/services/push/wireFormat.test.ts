// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The APNs/FCM wire formats (#490 phase 3).
//
// What this is and isn't: it proves we build the request Apple and Google
// document. It does NOT prove a phone renders it — there's no signed iOS build
// yet and Android is paused. That last mile stays open until there's a device to
// check against, and is called out on #490 rather than papered over.
//
// Still worth pinning here, because these dicts are the part with no other
// feedback loop: a wrong key in `aps` doesn't fail a typecheck, doesn't fail a
// request, and shows up as a notification that silently renders wrong.

import { describe, it, expect } from 'vitest';
import { buildApnsRequest } from './apnsSender.js';
import { buildFcmMessage } from './fcmSender.js';
import type { ApnsCredentials } from './credentials.js';
import type { PushSubscription } from '../../db/pushSubscriptions.js';
import {
  clampPushText,
  composeNotification,
  pushBody,
  type PushPayload,
} from '../notificationContent.js';

const creds: ApnsCredentials = {
  keyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  keyId: 'KEYID',
  teamId: 'TEAM',
  bundleId: 'chat.lurker.app',
  sandbox: false,
};

const sub = (endpoint = 'devicetoken123'): PushSubscription => ({
  id: 1,
  user_id: 1,
  endpoint,
  transport: 'apns',
  p256dh: null,
  auth: null,
  user_agent: null,
  enabled: true,
  created_at: '',
  last_seen_at: '',
  fail_count: 0,
});

const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
  kind: 'dm',
  networkId: 7,
  networkName: 'Libera',
  target: 'bob',
  nick: 'bob',
  text: 'hey there',
  messageId: 42,
  badge: 3,
  ...over,
});

describe('buildApnsRequest', () => {
  const build = (p: PushPayload = payload(), s = sub()) =>
    buildApnsRequest(s, p, composeNotification(p), creds, 'JWT');

  it('addresses the device and identifies the app', () => {
    const { headers } = build();
    expect(headers[':method']).toBe('POST');
    expect(headers[':path']).toBe('/3/device/devicetoken123');
    expect(headers['apns-topic']).toBe('chat.lurker.app');
    expect(headers.authorization).toBe('bearer JWT');
  });

  it('asks for immediate delivery of an alert', () => {
    const { headers } = build();
    // apns-push-type is REQUIRED since iOS 13 — omit it and Apple rejects the
    // request outright. Priority 5 would let APNs delay for power, which is
    // wrong for a chat message.
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
  });

  it('builds an aps dict with the composed copy', () => {
    const body = JSON.parse(build().body);
    expect(body.aps).toMatchObject({
      alert: { title: 'bob (Libera)', body: 'hey there' },
      badge: 3,
      sound: 'default',
      'thread-id': '7::bob',
    });
  });

  it('carries the routing keys tap-to-open needs, beside aps not inside it', () => {
    // Apple reserves `aps`; custom keys go at the top level. Nesting them inside
    // would silently strand tap-to-open with no buffer to jump to.
    const body = JSON.parse(build().body);
    expect(body).toMatchObject({ networkId: 7, target: 'bob', messageId: 42, kind: 'dm' });
    expect(body.aps.networkId).toBeUndefined();
  });

  it('omits the badge rather than sending 0 when there is none', () => {
    // A badge-less push means "the total can't have changed" (#451). Sending
    // `badge: 0` would CLEAR the user's app icon instead of leaving it alone —
    // worse than not sending it.
    const p = payload({ badge: undefined });
    const body = JSON.parse(build(p).body);
    expect('badge' in body.aps).toBe(false);
  });

  it('sends a zero badge when the total genuinely is zero', () => {
    const body = JSON.parse(build(payload({ badge: 0 })).body);
    expect(body.aps.badge).toBe(0);
  });

  it('collapses per buffer', () => {
    expect(build(payload({ text: 'one' })).headers['apns-collapse-id']).toBe(
      build(payload({ text: 'two' })).headers['apns-collapse-id'],
    );
    expect(build(payload({ target: '#other' })).headers['apns-collapse-id']).not.toBe(
      build().headers['apns-collapse-id'],
    );
  });

  it('hashes a collapse id that would exceed Apple 64-byte cap', () => {
    // APNs rejects a longer one with BadCollapseId. Channel names are UTF-8, so
    // the cap is on BYTES — a name of 40 emoji is under 64 characters and well
    // over 64 bytes.
    const longTarget = '#' + '🎉'.repeat(40);
    const p = payload({ target: longTarget });
    const id = build(p).headers['apns-collapse-id'];
    expect(Buffer.byteLength(id, 'utf8')).toBeLessThanOrEqual(64);
    // Hashed, not truncated: two buffers sharing a long prefix must not collide
    // into one collapse id and replace each other's notifications.
    const other = build(payload({ target: longTarget + 'x' })).headers['apns-collapse-id'];
    expect(id).not.toBe(other);
  });

  it('leaves a short collapse id readable', () => {
    expect(build().headers['apns-collapse-id']).toBe('7::bob');
  });
});

describe('buildFcmMessage', () => {
  const build = (p: PushPayload = payload()) =>
    buildFcmMessage(sub('fcmtoken456'), p, composeNotification(p)) as {
      message: Record<string, any>;
    };

  it('addresses the device with a data-only message', () => {
    const { message } = build();
    expect(message.token).toBe('fcmtoken456');
    // A `notification` block (top-level or under `android`) makes Android draw
    // the alert itself while the app is backgrounded, and the app's handler
    // never runs — no channel per kind, no tag replacement, and no way to
    // decrypt a relayed push (#1045).
    expect('notification' in message).toBe(false);
    expect('notification' in message.android).toBe(false);
  });

  it('asks for high priority and stays non-collapsible', () => {
    const { message } = build();
    expect(message.android.priority).toBe('HIGH');
    // FCM keeps only four collapse keys per offline device, dropping the rest at
    // random — per-buffer keys would lose whole buffers' notifications.
    expect('collapse_key' in message.android).toBe(false);
  });

  // Every PushPayload field set. Typed Required so a field added to the payload
  // later must be added here too — and then the reserved-key and scalar checks
  // below cover it.
  const full: Required<PushPayload> = {
    kind: 'dm',
    networkId: 7,
    networkName: 'Libera',
    target: 'bob',
    bufferId: 9,
    nick: 'bob',
    text: 'hey there',
    time: '2026-10-05T12:00:00.000Z',
    messageId: 42,
    displayName: 'bob',
    badge: 3,
  };

  it('carries the Web Push body, key for key', () => {
    // One renderer on the device reads both, so the data map must be the Web
    // Push body's keys with their values stringified — no key added, none lost.
    const { message } = build(full);
    expect(message.data).toEqual({
      kind: 'dm',
      networkId: '7',
      networkName: 'Libera',
      target: 'bob',
      bufferId: '9',
      nick: 'bob',
      text: 'hey there',
      time: '2026-10-05T12:00:00.000Z',
      messageId: '42',
      displayName: 'bob',
      badge: '3',
      title: 'bob (Libera)',
      body: 'hey there',
      tag: '7::bob',
    });
    expect(Object.keys(message.data).toSorted()).toEqual(
      Object.keys(pushBody(full, composeNotification(full))).toSorted(),
    );
  });

  it('uses no key FCM reserves, and no value that is not a scalar', () => {
    // FCM refuses a reserved key in `data` with INVALID_ARGUMENT, and an object
    // value would arrive as "[object Object]".
    const reserved = (key: string) =>
      ['from', 'notification', 'message_type'].includes(key) || /^(google|gcm)/i.test(key);
    const kinds: PushPayload['kind'][] = [
      'dm',
      'highlight',
      'always_notify',
      'friend_online',
      'kicked',
    ];
    for (const kind of kinds) {
      const { message } = build({ ...full, kind });
      expect(Object.keys(message.data).filter(reserved)).toEqual([]);
      expect(Object.values(message.data).filter((v) => String(v).startsWith('[object'))).toEqual(
        [],
      );
    }
  });

  it('fits a long multiline paste under the 4 KB message cap once clamped', () => {
    // The text rides twice (raw and as the stripped body). Four-byte characters
    // are the worst case for raw bytes; control characters (formatting codes)
    // and quotes are the worst case once JSON escapes them.
    for (const raw of ['😀'.repeat(4000), '\x02'.repeat(4000), '"'.repeat(4000)]) {
      const p = payload({ kind: 'highlight', target: '#lurker', text: clampPushText(raw) });
      const { message } = build(p);
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(4096);
    }
  });

  it('stringifies every data value', () => {
    // FCM rejects a non-string data value outright — and it would arrive as a
    // 400 INVALID_ARGUMENT, which classify() reads as permanent and DELETES the
    // device over. A number here costs a real subscription.
    const { message } = build();
    for (const [key, value] of Object.entries(message.data)) {
      expect(typeof value, `data.${key} must be a string`).toBe('string');
    }
  });

  it('omits optional data keys rather than sending "undefined"', () => {
    // String(undefined) is the string "undefined" — which FCM would happily
    // accept and the client would happily parse into nonsense.
    const { message } = build(payload({ messageId: null, badge: undefined, nick: null }));
    expect('messageId' in message.data).toBe(false);
    expect('badge' in message.data).toBe(false);
    expect('nick' in message.data).toBe(false);
  });
});
