// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which buffers' message lists are drawing the unread divider, by buffer key.
//
// The buffers store asks when a live line lands in the buffer being read: the
// divider follows the tail unless there's a boundary on screen to keep. Only
// the list can say whether there is one. A row past the read pointer can be
// hidden there — an ignored sender, a reply the thread panel holds, a filtered
// join — and a boundary with nothing visible under it isn't one: kept, it
// lands over the next line that is visible, the user's own included.
//
// Kept when a list unmounts (Settings, the mobile list screen), so a boundary
// the user hasn't come back to read yet still holds; a switch to another
// buffer resets the divider in the store anyway.

const shown = new Set<string>();

export function setUnreadDividerShown(key: string, on: boolean): void {
  if (on) shown.add(key);
  else shown.delete(key);
}

export function unreadDividerShown(key: string): boolean {
  return shown.has(key);
}
