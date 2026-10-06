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
}

// A domain Apple could plausibly reach: dotted, not an IP, not a local-only name.
function isPublicDomain(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (!h.includes('.') || net.isIP(h.replace(/^\[|\]$/g, ''))) return false;
  return !/\.(local|localhost|internal|lan|home\.arpa)$/.test(h);
}

function contactDomain(subject: string): string | null {
  let url: URL;
  try {
    url = new URL(subject);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.hostname;
  if (url.protocol === 'mailto:') {
    const at = url.pathname.lastIndexOf('@');
    return at === -1 ? null : url.pathname.slice(at + 1);
  }
  return null;
}

function appleAccepts(subject: string): boolean {
  const domain = contactDomain(subject);
  return domain !== null && isPublicDomain(domain);
}

export function resolveVapidSubject(env: NodeJS.ProcessEnv = process.env): VapidSubject {
  const configured = env.VAPID_SUBJECT?.trim();
  // The operator's choice stands even if Apple won't take it — they get told.
  if (configured) return { subject: configured, appleAccepts: appleAccepts(configured) };

  // WEBAUTHN_ORIGIN may list several origins (dev host plus public URL); the
  // first one Apple would accept wins.
  const origins = (env.WEBAUTHN_ORIGIN || '').split(',').map((s) => s.trim());
  for (const raw of origins) {
    let origin: string;
    try {
      origin = new URL(raw).origin;
    } catch {
      continue;
    }
    // appleAccepts() takes only https: and mailto:, so an http origin is skipped.
    if (appleAccepts(origin)) {
      return { subject: origin, appleAccepts: true };
    }
  }
  return { subject: FALLBACK, appleAccepts: false };
}
