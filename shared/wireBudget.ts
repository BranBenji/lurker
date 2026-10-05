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
// advertise a HOSTLEN — and the most we'll believe one that does: past any
// real host, a bigger number only shreds a paste into more lines.
export const DEFAULT_HOSTLEN = 63;
export const MAX_HOSTLEN = 255;

// The fixed budgets irc-framework split by, for an estimate with nothing to
// measure against (no connection, a server from before #1043): 350 bytes of
// text, and 350 - ('ACTION'.length + 3) = 341 for a /me body.
export const LEGACY_TEXT_BUDGET = 350;
export const LEGACY_ACTION_BUDGET = LEGACY_TEXT_BUDGET - ('ACTION'.length + 3);

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
