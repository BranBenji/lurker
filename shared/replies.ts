// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 replies (client-tags/reply, #993): the shape a reply's context rides a
// message row in, shared by the server (which resolves it) and the client
// (which draws the line above the reply).

// The line types a reply can answer and a thread can start from — the ones
// that are stored as lines someone said. Everything that finds a parent or a
// thread root by msgid filters on this, so they agree about what a root is.
export const REPLY_LINE_TYPES: readonly string[] = ['message', 'action', 'notice'];
export const REPLY_LINE_TYPES_SQL = `(${REPLY_LINE_TYPES.map((t) => `'${t}'`).join(', ')})`;

// How much of the answered line's text rides along. The client shows one
// clipped line of it, so anything past a screen's width is wire weight.
export const REPLY_EXCERPT_MAX = 300;

// The line a reply answers, as found by its msgid in the reply's own buffer.
export interface ReplyParent {
  id: number;
  nick: string;
  type: string;
  // At most REPLY_EXCERPT_MAX characters, formatting codes intact.
  text: string;
  // For the client's ignore check: a line from someone ignored since shows as
  // unavailable rather than quoting them.
  userhost: string | null;
  // One of the user's own lines — a reply to it from someone else is a
  // highlight, which a client re-evaluating highlight rules must keep.
  self: boolean;
}

// The answered line as a client quotes it: when it came through a marked relay
// bot, as the person inside the envelope, with the bot and the `[source]` kept
// for the label the timeline shows on that line (#996). `self` then says whether
// that person is the user (their nick on the line's network), not the bot.
export interface QuotedLine extends ReplyParent {
  relayBot?: string;
  relaySource?: string | null;
}

// On a message row that is a reply. `parent` is null when no line we hold
// carries that msgid: retention took it, it predates our history, it was a
// reaction (a TAGMSG, never stored as a line), or its author was ignored.
export interface ReplyContext {
  msgid: string;
  parent: ReplyParent | null;
}

// The msgid a line replies to, from its tags. `+reply` is the ratified name;
// `+draft/reply` is what older clients still send.
export function replyMsgidFromTags(tags: Record<string, string> | undefined): string | undefined {
  return tags?.['+reply'] || tags?.['+draft/reply'] || undefined;
}

// A composer draft's reply: the stored line it answers, and whether the Reply
// put `nick: ` into the draft's text (cancelling takes back only an address it
// put there). It rides the draft across devices, and an up-arrow history entry
// keeps the one it was sent with. This is what a client sends; the server sends
// back a DraftReply, with the line resolved as a reply's quote is.
export interface DraftReplyRef {
  messageId: number;
  addressed: boolean;
}

export interface DraftReply extends DraftReplyRef {
  parent: ReplyParent;
}

// A client's `reply` field: undefined when it sent none (a client that doesn't
// know about replies — the stored reply stays as it is), null to clear it or
// when it's malformed, else the ref.
export function parseDraftReplyRef(raw: unknown): DraftReplyRef | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const messageId = Number(r.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return null;
  return { messageId, addressed: r.addressed === true };
}
