// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Reply threads (#1225): which rows the message list keeps out of a channel
// while the setting is on. The ONE rule, shared by the list's render loop, the
// jump that opens a hidden row's thread, and the "N new ↓" counter — so a row
// the list won't draw is never counted or scrolled to.
//
// A reply that names its thread root lives in the panel — unless it is a
// highlight (a rule match, or an answer to one of the user's lines): that
// badges the channel, so it keeps a row to badge. A reply stored before roots
// were tracked has no root and shows inline, with its quote. `threadsHere` is
// the caller's "setting on, and this is a channel" (a DM keeps every line).
export function hiddenAsThreadReply(
  m: { replyTo?: { root?: string } | null; matched?: unknown; replyToSelf?: unknown },
  threadsHere: boolean,
): boolean {
  return threadsHere && !!m.replyTo?.root && !m.matched && !m.replyToSelf;
}
