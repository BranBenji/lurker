// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Test vectors for the push relay (lurker-dev/RELAY_PLAN.md §6.3). The relay and
// both apps decrypt what this server encrypts, and each tests against
// relayVectors.json — a copy of it lives in each of those repos. This suite is
// what keeps the file honest: every vector is rebuilt here from fixed inputs with
// the same pushBody() and http_ece the server sends with, so the three can't
// agree with each other and still disagree with the server.
//
// After a deliberate change to the push body: UPDATE_RELAY_VECTORS=1 npx vitest
// run server/services/push/relayVectors.test.ts, then copy the file to the relay
// and the apps.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ece from 'http_ece';
import {
  prepareNotification,
  RELAY_APNS_WRAPPER,
  type PushPayload,
} from '../notificationContent.js';
import { webpushBody } from './webpushSender.js';

const FILE = fileURLToPath(new URL('./relayVectors.json', import.meta.url));

// The relay wraps every push in an APNs alert (RELAY_PLAN.md §6.2). FCM's data
// message is just {"p": …}, so this is the larger of the two.
const APNS_LIMIT = 4096;
const apnsRelayPayload = (p: string) => RELAY_APNS_WRAPPER.replace('"p":""', `"p":"${p}"`);

// Deterministic keys: a P-256 scalar from a label. (Every 32-byte value below the
// group order is a valid key, and a SHA-256 output is, overwhelmingly.)
function ecdh(label: string): crypto.ECDH {
  const k = crypto.createECDH('prime256v1');
  k.setPrivateKey(crypto.createHash('sha256').update(label).digest());
  return k;
}
const bytes = (label: string, n: number) =>
  crypto.createHash('sha256').update(label).digest().subarray(0, n).toString('base64url');

// Exactly the body deliver() hands web-push: the same preparation and the same
// serialization, not a copy of them.
function asDelivered(raw: PushPayload): string {
  const { payload, content } = prepareNotification(raw);
  return webpushBody(payload, content);
}

const CASES: { name: string; payload: PushPayload }[] = [
  {
    name: 'dm',
    payload: {
      kind: 'dm',
      networkId: 3,
      networkName: 'Libera',
      target: 'bob',
      bufferId: 42,
      nick: 'bob',
      text: 'hey, are you around? \x02café\x02 ☕ 🎉',
      time: '2026-10-06T18:30:00.000Z',
      messageId: 9001,
      displayName: 'Bob Example',
      badge: 3,
    },
  },
  {
    name: 'highlight',
    payload: {
      kind: 'highlight',
      networkId: 1,
      networkName: 'Ergo',
      target: '#lurker',
      bufferId: 7,
      nick: 'alice',
      text: 'amiantos: the relay works',
      time: '2026-10-06T18:31:00.000Z',
      messageId: 9002,
      badge: 4,
    },
  },
  {
    // As big as the server will make a push: a kick (kicker, channel and network
    // all in the title) with every name long and in four-byte characters, so
    // prepareNotification has to cut it down to fit.
    name: 'worst-case',
    payload: {
      kind: 'kicked',
      networkId: 2147483647,
      networkName: '🌐'.repeat(500),
      target: `#${'📣'.repeat(120)}`,
      bufferId: 2147483647,
      nick: '👤'.repeat(64),
      text: '"'.repeat(4000),
      time: '2026-10-06T18:32:00.000Z',
      messageId: 2147483647,
      displayName: '👤'.repeat(64),
      badge: 99999,
    },
  },
];

interface Vector {
  name: string;
  plaintext: string;
  /** Receiver (the phone): its private key, public key and auth secret. */
  uaPrivate: string;
  uaPublic: string;
  authSecret: string;
  /** Sender (the server's per-push ephemeral key) and salt. */
  asPrivate: string;
  asPublic: string;
  salt: string;
  /** The aes128gcm request body: what the relay forwards in `p`. */
  body: string;
}

function build(name: string, plaintext: string): Vector {
  const ua = ecdh(`lurker-relay-vector/${name}/ua`);
  const as = ecdh(`lurker-relay-vector/${name}/as`);
  const salt = bytes(`lurker-relay-vector/${name}/salt`, 16);
  const authSecret = bytes(`lurker-relay-vector/${name}/auth`, 16);
  // Exactly the options web-push's encryption-helper passes.
  const body = ece.encrypt(Buffer.from(plaintext), {
    version: 'aes128gcm',
    dh: ua.getPublicKey('base64url'),
    privateKey: as,
    salt,
    authSecret,
  });
  return {
    name,
    plaintext,
    uaPrivate: ua.getPrivateKey('base64url'),
    uaPublic: ua.getPublicKey('base64url'),
    authSecret,
    asPrivate: as.getPrivateKey('base64url'),
    asPublic: as.getPublicKey('base64url'),
    salt,
    body: body.toString('base64url'),
  };
}

// RFC 8291 Appendix A, verbatim.
const RFC8291: Vector = {
  name: 'rfc8291-appendix-a',
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function expected() {
  return {
    about:
      'Push relay test vectors (lurker-dev/RELAY_PLAN.md §6.3). Generated by ' +
      'lurker server/services/push/relayVectors.test.ts; do not edit by hand. ' +
      'All binary values are base64url without padding.',
    vectors: [RFC8291, ...CASES.map((c) => build(c.name, asDelivered(c.payload)))],
  };
}

function decrypt(v: Vector): string {
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(Buffer.from(v.uaPrivate, 'base64url'));
  return ece
    .decrypt(Buffer.from(v.body, 'base64url'), {
      version: 'aes128gcm',
      privateKey: ua,
      authSecret: v.authSecret,
    })
    .toString();
}

describe('relay test vectors', () => {
  const want = expected();

  if (process.env.UPDATE_RELAY_VECTORS) {
    fs.writeFileSync(FILE, `${JSON.stringify(want, null, 2)}\n`);
  }

  it('match the file the relay and the apps test against', () => {
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual(want);
  });

  it.each(want.vectors.map((v) => [v.name, v] as const))('%s decrypts', (_name, v) => {
    expect(decrypt(v)).toBe(v.plaintext);
  });

  it('carry the RFC 8291 body byte for byte when re-encrypted', () => {
    const v = want.vectors[0];
    const as = crypto.createECDH('prime256v1');
    as.setPrivateKey(Buffer.from(v.asPrivate, 'base64url'));
    const body = ece.encrypt(Buffer.from(v.plaintext), {
      version: 'aes128gcm',
      dh: v.uaPublic,
      privateKey: as,
      salt: v.salt,
      authSecret: v.authSecret,
    });
    expect(body.toString('base64url')).toBe(v.body);
  });

  it("fit APNs' 4 KB once the relay wraps them, even the worst case", () => {
    for (const v of want.vectors) {
      expect(Buffer.byteLength(apnsRelayPayload(v.body))).toBeLessThanOrEqual(APNS_LIMIT);
    }
  });

  it('are encrypted with the http_ece web-push itself sends with', () => {
    // Pinned for this suite, and handed to web-push through package.json's
    // overrides; a bump that drifted from web-push's copy would make the
    // vectors check a different library.
    const req = createRequire(import.meta.url);
    const fromWebPush = createRequire(req.resolve('web-push')).resolve('http_ece');
    expect(req.resolve('http_ece')).toBe(fromWebPush);
  });
});
