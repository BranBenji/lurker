// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { resolveVapidSubject } from './vapidSubject.js';

describe('resolveVapidSubject', () => {
  it('uses VAPID_SUBJECT when set', () => {
    expect(
      resolveVapidSubject({
        VAPID_SUBJECT: 'mailto:ops@example.com',
        WEBAUTHN_ORIGIN: 'https://lurker.example.org',
      }),
    ).toEqual({ subject: 'mailto:ops@example.com', appleAccepts: true });
  });

  it('keeps an operator-set subject Apple will refuse, but says so', () => {
    expect(resolveVapidSubject({ VAPID_SUBJECT: 'mailto:me@localhost' })).toEqual({
      subject: 'mailto:me@localhost',
      appleAccepts: false,
    });
  });

  it("falls back to the server's own https origin", () => {
    expect(resolveVapidSubject({ WEBAUTHN_ORIGIN: 'https://lurker.example.com/' })).toEqual({
      subject: 'https://lurker.example.com',
      appleAccepts: true,
    });
  });

  it('takes the first origin Apple would accept from a list', () => {
    const r = resolveVapidSubject({
      WEBAUTHN_ORIGIN:
        'https://irc.local:5173, http://chat.example.com, https://192.168.1.5, https://chat.example.com',
    });
    expect(r.subject).toBe('https://chat.example.com');
  });

  it.each([
    ['nothing set', {}],
    ['localhost', { WEBAUTHN_ORIGIN: 'https://localhost:8015' }],
    ['a .local name', { WEBAUTHN_ORIGIN: 'https://lurker.local' }],
    ['a single label', { WEBAUTHN_ORIGIN: 'https://lurker' }],
    ['an IPv4 address', { WEBAUTHN_ORIGIN: 'https://10.0.0.2' }],
    ['an IPv6 address', { WEBAUTHN_ORIGIN: 'https://[fd00::1]' }],
    ['a home.arpa name', { WEBAUTHN_ORIGIN: 'https://lurker.home.arpa' }],
    ['plain http', { WEBAUTHN_ORIGIN: 'http://lurker.example.com' }],
  ])('uses the flagged placeholder with %s', (_label, env) => {
    expect(resolveVapidSubject(env)).toEqual({
      subject: 'mailto:lurker@localhost',
      appleAccepts: false,
    });
  });
});
