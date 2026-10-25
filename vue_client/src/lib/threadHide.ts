// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Reply threads (#1225): which rows the message list keeps out of a channel
// while the setting is on. The ONE rule, shared by the list's render loop, the
// jump that opens a hidden row's thread, and the "N new ↓" counter — so a row
// the list won't draw is never counted or scrolled to.
//
// A reply that names its thread root lives in the panel, highlight or not: a
// mention inside a thread still badges the channel (the server counts it) and
// lights the Threads button in the header, which is where it is read. A reply
// stored before roots were tracked has no root and shows inline, with its
// quote. `threadsHere` is the caller's "setting on, and this is a channel" (a
// DM keeps every line).
export function hiddenAsThreadReply(
  m: { replyTo?: { root?: string } | null },
  threadsHere: boolean,
): boolean {
  return threadsHere && !!m.replyTo?.root;
}
