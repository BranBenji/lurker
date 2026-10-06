// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The VAPID `sub` claim: a contact for this server, sent in every Web Push JWT.
//
// RFC 8292 allows a mailto: or an https: URL. Chrome and Firefox take anything,
// but Apple's push service answers 403 BadJwtToken to a contact it can't reach —
// `localhost`, a `.local` name, a bare IP — so an unset VAPID_SUBJECT used to
// mean push worked everywhere except Safari and iOS home-screen apps, silently.
//
// So, in order: VAPID_SUBJECT; else this server's own public URL, which every
// documented setup already gives as WEBAUTHN_ORIGIN; else a placeholder that
// keeps Chrome and Firefox working, flagged so the admin is told why iOS isn't.

import net from 'node:net';

const FALLBACK = 'mailto:lurker@localhost';

export interface VapidSubject {
  subject: string;
  /** False when Apple will refuse it: the admin should set VAPID_SUBJECT. */
  appleAccepts: boolean;
  /** A VAPID_SUBJECT that was set but not used, because it was unusable or
   *  Apple would refuse it and the server's own URL wouldn't. */
  ignored: string | null;
}

// Names that never resolve publicly: RFC 6761/2606 special-use names, mDNS,
// home.arpa, .onion, and the private suffixes routers and distros hand out.
const PRIVATE_SUFFIX =
  /\.(local|localhost|localdomain|test|invalid|example|onion|internal|intranet|corp|lan|home\.arpa)$/;

// A domain Apple could plausibly reach: dotted, not an IP, not a private name.
function isPublicDomain(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (!h.includes('.') || net.isIP(h.replace(/^\[|\]$/g, ''))) return false;
  return !PRIVATE_SUFFIX.test(h);
}

// One plain mailbox: no spaces, brackets, or second @, and an ASCII domain
// (an IDN has to be given as punycode). Read from the raw string, not
// URL.pathname — that keeps a space after `mailto:` and percent-encoding, both
// of which Apple refuses, and an encoded domain would dodge the suffix check.
const MAILTO = /^mailto:[^\s@<>()",;:\\[\]%]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?)(?:\?.*)?$/;

// The contact's domain, or null when it isn't a usable subject at all — not a
// URL, not https:/mailto: (web-push throws on those), or not one plain mailbox.
// Anything this returns a domain for, web-push accepts.
function contactDomain(subject: string): string | null {
  let url: URL;
  try {
    url = new URL(subject);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.hostname || null;
  if (url.protocol === 'mailto:') return MAILTO.exec(subject)?.[1] ?? null;
  return null;
}

function appleAccepts(subject: string): boolean {
  const domain = contactDomain(subject);
  return domain !== null && isPublicDomain(domain);
}

// WEBAUTHN_ORIGIN may list several origins (dev host plus public URL); the
// first one Apple would accept wins.
function publicOrigin(env: NodeJS.ProcessEnv): string | null {
  for (const raw of (env.WEBAUTHN_ORIGIN || '').split(',')) {
    let origin: string;
    try {
      origin = new URL(raw.trim()).origin;
    } catch {
      continue;
    }
    // appleAccepts() takes only https: and mailto:, so an http origin is skipped.
    if (appleAccepts(origin)) return origin;
  }
  return null;
}

export function resolveVapidSubject(env: NodeJS.ProcessEnv = process.env): VapidSubject {
  const configured = env.VAPID_SUBJECT?.trim() || null;
  if (configured && appleAccepts(configured)) {
    return { subject: configured, appleAccepts: true, ignored: null };
  }
  // A subject Apple refuses — or one web-push would throw on, which would break
  // push in every browser — loses to the server's own URL when there is one.
  const origin = publicOrigin(env);
  if (origin) return { subject: origin, appleAccepts: true, ignored: configured };
  // No better option: a usable subject stands, so Chrome and Firefox work.
  if (configured && contactDomain(configured) !== null) {
    return { subject: configured, appleAccepts: false, ignored: null };
  }
  return { subject: FALLBACK, appleAccepts: false, ignored: configured };
}
