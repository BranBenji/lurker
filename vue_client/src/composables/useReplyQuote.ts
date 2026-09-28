// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { useIgnoresStore } from '../stores/ignores.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import { stripReplyAddress } from '../utils/replyText.js';
import type { ReplyContext, ReplyParent } from '../../../shared/replies.js';

// How a reply reads — its quote (ReplyQuote) and its own text — shared by the
// timeline (MessageList) and the out-of-buffer rows: search, activity,
// bookmarks (HistoryMessageRow, #998). One rule, so a reply reads the same
// wherever it turns up.
export function useReplyQuote() {
  const ignores = useIgnoresStore();
  const relayBots = useRelayBotsStore();

  // `line` is the reply as it displays (a relayed line already unwrapped).
  // `parent`: the answered line as the quote shows it — null for "unavailable",
  // which also covers a line from someone ignored since it arrived (the server
  // only screens out who was ignored at the time), judged as the line it was,
  // in the reply's buffer. `text`: the reply's own text, without the `alice: `
  // it opens with when the quote names her — how halloy and goguma send one,
  // so clients without replies still see who it's for. Only then: with the
  // quote unavailable, that address is the only sign of who it's to.
  //
  // A quoted line from a marked relay bot (#996) shows the person inside its
  // envelope — `<alice> hi`, not `<bridgebot> <alice> hi` — as the timeline shows
  // that line, and the address compares against her. The ignore check comes
  // first and judges the line as the bot's, again as the timeline judges it, so
  // a quote never hides a line its row would show, or shows one it would hide.
  function shownReply(
    replyTo: ReplyContext,
    line: { type?: string; text?: string | null },
    networkId: number | null | undefined,
    target: string,
  ): { parent: ReplyParent | null; text: string } {
    let parent = replyTo.parent;
    if (
      parent &&
      !parent.self &&
      networkId != null &&
      ignores.isMessageHidden(networkId, { ...parent, target })
    ) {
      parent = null;
    }
    if (parent && parent.type === 'message' && !parent.self && networkId != null) {
      const relayed = relayBots.unwrap(networkId, parent.nick, parent.text);
      if (relayed) parent = { ...parent, nick: relayed.nick, text: relayed.text };
    }
    const text = line.text ?? '';
    return {
      parent,
      text: parent && line.type === 'message' ? stripReplyAddress(text, parent.nick) : text,
    };
  }

  return { shownReply };
}
