// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// How much message text fits one IRC line as the network relays it to everyone
// else (#1043). The network puts our prefix in front — `:nick!user@host
// PRIVMSG target :text\r\n` — and the whole line is 512 bytes, so the room for
// text depends on who we are and who it's for. The server splits by this and
// the composer estimates by it, so both use this one formula.
//
// It used to be irc-framework's fixed 350 bytes: a guess that left ~100 bytes
// unused on most networks and still overflowed behind a long enough host.

export const IRC_LINE_BYTES = 512;

// The host length to assume while ours is unknown, where the network doesn't
// advertise a HOSTLEN.
export const DEFAULT_HOSTLEN = 63;

// Never split into pieces smaller than this, whatever the arithmetic says: a
// network advertising an absurd HOSTLEN would otherwise leave no room at all.
export const MIN_TEXT_BUDGET = 64;

// What each split piece of a /me pays for its `\x01ACTION ` … `\x01` wrapper.
export const ACTION_WRAPPER_BYTES = 9;

const encoder = new TextEncoder();
function byteLen(s: string): number {
  return encoder.encode(s).byteLength;
}

/** Bytes of text one PRIVMSG/NOTICE to `target` can carry, behind
 *  `:nick!<userhostBytes> `. `action`: the text is a /me body, inside the
 *  CTCP wrapper. Tags ride a budget of their own and don't count. */
export function textBudget(opts: {
  nick: string;
  userhostBytes: number;
  command: string;
  target: string;
  action?: boolean;
}): number {
  // `:nick!` + user@host + ` CMD target :` + CRLF.
  const head = byteLen(`:${opts.nick}! ${opts.command} ${opts.target} :`) + opts.userhostBytes + 2;
  const wrapper = opts.action ? ACTION_WRAPPER_BYTES : 0;
  return Math.max(MIN_TEXT_BUDGET, IRC_LINE_BYTES - head - wrapper);
}
