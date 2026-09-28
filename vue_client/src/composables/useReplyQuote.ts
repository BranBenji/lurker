// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { useIgnoresStore } from '../stores/ignores.js';
import type { ReplyParent } from '../../../shared/replies.js';

// What a reply's quote (ReplyQuote) shows, shared by the timeline (MessageList)
// and the out-of-buffer rows — search, activity, bookmarks (HistoryMessageRow,
// #998) — so a reply reads the same wherever it turns up.
export function useReplyQuote() {
  const ignores = useIgnoresStore();

  // The answered line as the quote shows it — or null for "unavailable", which
  // also covers a line from someone ignored since it arrived (the server only
  // screens out who was ignored at the time). Judged as the line it was, in the
  // reply's buffer.
  function shownParent(
    parent: ReplyParent | null,
    networkId: number | null | undefined,
    target: string,
    isDm: boolean,
  ): ReplyParent | null {
    if (!parent) return null;
    if (!parent.self && parent.nick && networkId != null) {
      const verdict = ignores.evaluate(networkId, {
        nick: parent.nick,
        userhost: parent.userhost,
        target,
        text: parent.text,
        type: parent.type,
        isDm,
      });
      if (verdict.hide) return null;
    }
    return parent;
  }

  return { shownParent };
}
