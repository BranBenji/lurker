// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Whether a buffer's message list is drawing the unread divider, by buffer key:
// true, false, or null when no list has said so for this visit.
//
// The buffers store asks when a live line lands in the buffer being read: the
// divider follows the tail unless there's a boundary on screen to keep. Only
// the list can say whether there is one. A row past the read pointer can be
// hidden there — an ignored sender, a reply the thread panel holds, a filtered
// join — and a boundary with nothing visible under it isn't one: kept, it
// lands over the next line that is visible, the user's own included.
//
// No answer (null) is not "no divider": opening a buffer clears it, and so does
// the list unmounting (Settings, the mobile list or members screen), and the
// store then keeps the boundary wherever rows sit past it, as it always did.

const shown = new Map<string, boolean>();

export function setUnreadDividerShown(key: string, on: boolean | null): void {
  if (on === null) shown.delete(key);
  else shown.set(key, on);
}

export function unreadDividerShown(key: string): boolean | null {
  return shown.get(key) ?? null;
}
