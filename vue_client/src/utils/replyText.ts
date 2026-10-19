// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { hidesText, parseIrcFormatting } from './nickColor.js';
import { escapeRegex } from '../../../shared/textMatch.js';
import { quoteMarks } from '../../../shared/replies.js';
import { byteLen } from './messageSplit.js';

// Text helpers for IRCv3 replies (#993), shared by the reply line above a
// message (MessageList) and the pending-reply segment (StatusBar).

// The answered line as one line of plain text: formatting codes dropped, line
// breaks folded to spaces. Callers clip it to width with CSS.
export function replyExcerpt(text: string): string {
  return flattenRuns(text, false);
}

// `keepSpoilers` writes a hidden run (fg = bg, hidesText) back as `||text||` — the composer's
// markup, which applySpoilerMarkup hides again on the way out — so a quote of
// a spoiler stays one. The display drops it: the quote above a message is
// already faded, and SpoilerText does its own hiding.
function flattenRuns(text: string, keepSpoilers: boolean): string {
  return parseIrcFormatting(text)
    .map((run) => (keepSpoilers && hidesText(run.fg, run.bg) ? `||${run.text}||` : run.text))
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
// line (quoteMarks) behind `> `, as prose by the rule the reply quote above a
// message reads by (flattenRuns), with a spoiler kept as `||…||`. Plain text
// for the people on clients that never see a reply tag. `maxBytes` is the
// wire budget for one line: a quote is an excerpt, and one that didn't fit
// would split into a second message of its own, so it's clipped to fit with
// an ellipsis. `measure` says how many bytes a draft line is on the wire —
// the composer's rewrites `||…||` into colour codes, which weigh more.
export function quoteLineFor(
  line: QuoteSource,
  maxBytes?: number,
  measure: (s: string) => number = byteLen,
): string {
  const [open, close] = quoteMarks(line.type);
  const head = `> ${open}${line.nick}${close}`;
  const text = flattenRuns(line.text, true);
  if (!text) return head;
  const full = `${head} ${text}`;
  if (maxBytes == null || measure(full) <= maxBytes) return full;
  // The space and the ellipsis (three bytes) come out of the text's room.
  let room = maxBytes - measure(head) - 1 - 3;
  while (room > 0) {
    let clipped = clipUtf8(text, room);
    // A cut inside a spoiler leaves it open — and its text in the clear.
    if ((clipped.match(/\|\|/g) ?? []).length % 2 === 1) clipped += '||';
    const out = `${head} ${clipped}…`;
    if (measure(out) <= maxBytes) return out;
    room -= measure(out) - maxBytes;
  }
  return head;
}

// A draft's leading quote lines (the Quote action's, each `> …` and complete)
// and the answer under them. The address a Reply puts in, and takes back,
// belongs to the answer; a new quote goes under the quotes it follows.
export function splitQuoteBlock(draft: string): { quotes: string; body: string } {
  const m = /^(?:> [^\n]*\n)*/.exec(draft);
  const quotes = m ? m[0] : '';
  return { quotes, body: draft.slice(quotes.length) };
}

// The longest prefix of `s` within `bytes` of UTF-8, cut between code points so
// no character is torn, with trailing whitespace dropped.
function clipUtf8(s: string, bytes: number): string {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const n = byteLen(ch);
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
