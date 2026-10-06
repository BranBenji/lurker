// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { resolveVapidSubject } from './vapidSubject.js';

const FALLBACK = 'mailto:lurker@localhost';
const ORIGIN = 'https://chat.lurker.chat';

describe('resolveVapidSubject', () => {
  it('uses VAPID_SUBJECT when Apple would accept it', () => {
    expect(
      resolveVapidSubject({ VAPID_SUBJECT: 'mailto:ops@lurker.chat', WEBAUTHN_ORIGIN: ORIGIN }),
    ).toEqual({ subject: 'mailto:ops@lurker.chat', appleAccepts: true, ignored: null });
  });

  it("falls back to the server's own https origin when it's unset", () => {
    expect(resolveVapidSubject({ WEBAUTHN_ORIGIN: `${ORIGIN}/` })).toEqual({
      subject: ORIGIN,
      appleAccepts: true,
      ignored: null,
    });
  });

  it.each([
    ['one Apple refuses', 'mailto:me@localhost'],
    ['a blank mailto (an empty ADMIN_EMAIL in compose)', 'mailto:'],
    ['a mailto with no user part', 'mailto:@lurker.chat'],
    ['one web-push would throw on', 'ops@lurker.chat'],
    ['a quoted value', '"mailto:ops@lurker.chat"'],
    ['a space after mailto:', 'mailto: ops@lurker.chat'],
    ['an angle-bracket address', 'mailto:<ops@lurker.chat>'],
    ['two @ signs', 'mailto:ops@evil@lurker.chat'],
    ['a percent-encoded private domain', 'mailto:ops@chat.lurker%E3%80%82local'],
  ])("prefers the server's origin over a VAPID_SUBJECT that's %s", (_label, configured) => {
    expect(resolveVapidSubject({ VAPID_SUBJECT: configured, WEBAUTHN_ORIGIN: ORIGIN })).toEqual({
      subject: ORIGIN,
      appleAccepts: true,
      ignored: configured,
    });
  });

  it('keeps a usable VAPID_SUBJECT Apple refuses when there is nothing better, and says so', () => {
    expect(resolveVapidSubject({ VAPID_SUBJECT: 'mailto:me@localhost' })).toEqual({
      subject: 'mailto:me@localhost',
      appleAccepts: false,
      ignored: null,
    });
  });

  it('never hands web-push a subject it would throw on', () => {
    expect(resolveVapidSubject({ VAPID_SUBJECT: 'ops@lurker.chat' })).toEqual({
      subject: FALLBACK,
      appleAccepts: false,
      ignored: 'ops@lurker.chat',
    });
  });

  it('takes the first origin Apple would accept from a list', () => {
    const r = resolveVapidSubject({
      WEBAUTHN_ORIGIN: `https://irc.local:5173, http://chat.lurker.chat, https://192.168.1.5, ${ORIGIN}`,
    });
    expect(r.subject).toBe(ORIGIN);
  });

  it.each([
    ['nothing set', {}],
    ['localhost', { WEBAUTHN_ORIGIN: 'https://localhost:8015' }],
    ['a .local name', { WEBAUTHN_ORIGIN: 'https://lurker.local' }],
    ['a .localdomain name', { WEBAUTHN_ORIGIN: 'https://lurker.localdomain' }],
    ['an .onion name', { WEBAUTHN_ORIGIN: 'https://abcdef.onion' }],
    ['a .test name', { WEBAUTHN_ORIGIN: 'https://lurker.test' }],
    ['a home.arpa name', { WEBAUTHN_ORIGIN: 'https://lurker.home.arpa' }],
    ['an encoded .local name', { WEBAUTHN_ORIGIN: 'https://chat.lurker%E3%80%82local' }],
    ['a single label', { WEBAUTHN_ORIGIN: 'https://lurker' }],
    ['an IPv4 address', { WEBAUTHN_ORIGIN: 'https://10.0.0.2' }],
    ['an IPv6 address', { WEBAUTHN_ORIGIN: 'https://[fd00::1]' }],
    ['plain http', { WEBAUTHN_ORIGIN: 'http://chat.lurker.chat' }],
  ])('uses the flagged placeholder with %s', (_label, env) => {
    expect(resolveVapidSubject(env)).toEqual({
      subject: FALLBACK,
      appleAccepts: false,
      ignored: null,
    });
  });

  it('accepts a real domain even if it looks like a placeholder', () => {
    // example.com resolves publicly and Apple takes it. A placeholder contact
    // is a poor contact, not a refused one.
    expect(resolveVapidSubject({ VAPID_SUBJECT: 'mailto:you@example.com' })).toEqual({
      subject: 'mailto:you@example.com',
      appleAccepts: true,
      ignored: null,
    });
  });

  it('accepts a mailto with a query, and a punycode domain', () => {
    for (const s of ['mailto:ops@lurker.chat?subject=push', 'mailto:ops@xn--bcher-kva.ch']) {
      expect(resolveVapidSubject({ VAPID_SUBJECT: s }).appleAccepts).toBe(true);
    }
  });
});
