// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { parseIrcFormatting } from './nickColor.js';
import { escapeRegex } from '../../../shared/textMatch.js';
import { quoteMarks } from '../../../shared/replies.js';

// Text helpers for IRCv3 replies (#993), shared by the reply line above a
// message (MessageList) and the pending-reply segment (StatusBar).

// The answered line as one line of plain text: formatting codes dropped, line
// breaks folded to spaces. Callers clip it to width with CSS.
export function replyExcerpt(text: string): string {
  return parseIrcFormatting(text)
    .map((run) => run.text)
    .join('')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

// What the Quote action (#1119) quotes: a line's author, type and text — a
// relayed line already unwrapped to the person inside the envelope.
export interface QuoteSource {
  nick: string;
  type?: string | null;
  text: string;
}

// The Quote action's line: `> <alice> what she said`, the way IRC writes the
// line (quoteMarks) behind `> `, as prose (replyExcerpt — the one rule the
// reply quote above a message also reads by). Plain text for the people on
// clients that never see a reply tag. `maxBytes` is the wire budget for one
// line: a quote is an excerpt, and one that didn't fit would split into a
// second message of its own, so it's clipped to fit with an ellipsis.
export function quoteLineFor(line: QuoteSource, maxBytes?: number): string {
  const [open, close] = quoteMarks(line.type);
  const head = `> ${open}${line.nick}${close}`;
  const text = replyExcerpt(line.text);
  if (!text) return head;
  const full = `${head} ${text}`;
  if (maxBytes == null || utf8Length(full) <= maxBytes) return full;
  // The space and the ellipsis (three bytes) come out of the text's room.
  const room = maxBytes - utf8Length(head) - 1 - 3;
  if (room <= 0) return head;
  return `${head} ${clipUtf8(text, room)}…`;
}

// A draft's leading quote lines (the Quote action's, each `> …` and complete)
// and the answer under them. The address a Reply puts in, and takes back,
// belongs to the answer; a new quote goes under the quotes it follows.
export function splitQuoteBlock(draft: string): { quotes: string; body: string } {
  const m = /^(?:> [^\n]*\n)*/.exec(draft);
  const quotes = m ? m[0] : '';
  return { quotes, body: draft.slice(quotes.length) };
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

// The longest prefix of `s` within `bytes` of UTF-8, cut between code points so
// no character is torn, with trailing whitespace dropped.
function clipUtf8(s: string, bytes: number): string {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const n = utf8Length(ch);
    if (used + n > bytes) break;
    used += n;
    out += ch;
  }
  return out.trimEnd();
}

// A character that cannot continue a nick, which is what "punctuation after
// the nick" has to mean when telling `nick: hi` from a line that just opens
// with a word: not a letter or digit (Unicode — `\w` is ASCII-only, so `bobł`
// would read as bob + a mark), not whitespace, and not one of the RFC 2812 nick
// specials `[]\`_^{|}-` — or `bob_: hi` would count as addressing bob, and bob_
// is every ghost's nick. The one definition: the composer's address matching
// (MessageInput) and the reply display's (stripReplyAddress) must agree on it.
export const NOT_NICK_CHAR = '[^\\p{L}\\p{N}\\s_\\[\\]\\\\`^{|}-]';

// A reply's text without the `nick: ` it opens with when it names the author it
// answers — how halloy and goguma send one, and how our composer does, so a
// client without replies still sees who it's for. The reply line above already
// names them. Only a nick followed by punctuation counts: a reply to `will`
// saying "will you come?" keeps its first word. Never strips to nothing.
export function stripReplyAddress(text: string, nick: string): string {
  if (!nick) return text;
  const re = new RegExp(`^${escapeRegex(nick)}${NOT_NICK_CHAR}+\\s+`, 'iu');
  const stripped = text.replace(re, '');
  return stripped || text;
}
