// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Its own module so the message store can ask it too (the bouncer's history
// windows and TARGETS, db/messages.ts), not only the bouncer.

// Network-services pseudo-users (NickServ/ChanServ/…). Playback replays their
// buffers like any DM, but never the user's OWN lines to them — the self side
// routinely contains credentials (`msg NickServ IDENTIFY <password>` from a
// client's perform/on-connect) that would otherwise land in every attached
// client's logs on every reconnect.
export function isServicesNick(nick: string): boolean {
  const lower = nick.toLowerCase();
  // *serv (NickServ/ChanServ/AuthServ/…) covers most networks; the short list
  // catches well-known non-*serv auth bots (QuakeNet Q, Undernet X/W) whose
  // self-lines also carry AUTH credentials. Best-effort — over-matching only
  // withholds a user's own DMs from playback; the durable fix is tagging
  // credential-bearing messages at persist time.
  return (
    /^[a-z]+serv$/.test(lower) ||
    lower === 'global' ||
    lower === 'services' ||
    lower === 'q' ||
    lower === 'x' ||
    lower === 'w'
  );
}
