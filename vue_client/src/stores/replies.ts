// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { useDraftStore } from './drafts.js';

// IRCv3 replies (#993): the reply being composed, per buffer. The Reply action
// on a line sets it, the status bar shows it ("↩ alice …  ×"), and the next
// line sent from that buffer's composer carries its `replyTo`. Kept per buffer
// — switching away and back finds it still pending, as a draft is.
//
// It IS part of the draft: the drafts store holds it and syncs it with the
// text, so a message started as a reply on one device is still one on another,
// and after a reload. This store is its face — what a Reply, the status bar and
// a send deal in. The server re-checks everything about the line (the buffer,
// the msgid, the network's support) and sends a plain line when it can't reply.

export interface PendingReply {
  // The stored line being answered — what `replyTo` names on the wire.
  messageId: number;
  nick: string;
  type: string;
  text: string;
  // A reply to your own line (#997) — the status bar says "yourself".
  self?: boolean;
  // The Reply put `nick: ` into the draft (it doesn't when the draft already
  // opens with it). Only then does cancelling take it back out — an address the
  // user typed is theirs.
  addressed?: boolean;
}

// By buffer key (networks.activeKey's form). A closed buffer's reply goes with
// its draft, and a renamed one's follows it (the drafts store's lifecycle hooks).
export const useRepliesStore = defineStore('replies', {
  getters: {
    forKey:
      () =>
      (key: string | null | undefined): PendingReply | null =>
        useDraftStore().replyForKey(key),
  },
  actions: {
    start(key: string, reply: PendingReply) {
      // Reply again on a line by the same author: the address in the draft is
      // still the one the first Reply put there. Stored as our own copy — the
      // caller's object is theirs, and markAddressed must not reach into it.
      const prev = this.forKey(key);
      const addressed = !!reply.addressed || (!!prev?.addressed && prev.nick === reply.nick);
      useDraftStore().setReplyForKey(key, { ...reply, addressed });
    },
    // Put a reply back as it was, or none: an up-arrow recall (the entry's own
    // reply) and the walk back down to the draft (the one it had).
    set(key: string, reply: PendingReply | null) {
      useDraftStore().setReplyForKey(key, reply ? { ...reply } : null);
    },
    // The composer put `nick: ` in the draft for this buffer's pending reply.
    markAddressed(key: string, nick: string) {
      const reply = this.forKey(key);
      if (reply && reply.nick === nick) {
        useDraftStore().setReplyForKey(key, { ...reply, addressed: true });
      }
    },
    cancel(key: string | null | undefined) {
      if (key) useDraftStore().setReplyForKey(key, null);
    },
  },
});
