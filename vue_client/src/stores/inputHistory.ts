// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import type { PendingReply } from './replies.js';

function key(networkId: number | string, target: string) {
  return `${networkId}::${target}`;
}

// Per-buffer history of every line submitted through the input bar (chat,
// /raw, even client-only lines like /commands). Server is the source of
// truth; this store mirrors the most-recent slice the server ships on snapshot
// plus optimistic local appends on submit. MessageInput drives up/down recall
// off `forBuffer`, and `replyAt` gives back the reply an entry was sent as, so
// a recalled reply is a reply again.
export const useInputHistoryStore = defineStore('inputHistory', {
  state: () => ({
    history: {} as Record<string, string[]>,
    // Index for index with `history`; sparse — a buffer none of whose entries
    // was a reply has none.
    replies: {} as Record<string, Array<PendingReply | null>>,
  }),
  getters: {
    forBuffer: (state) => (networkId: number | string, target: string) =>
      state.history[key(networkId, target)] || [],
    replyAt:
      (state) =>
      (networkId: number | string, target: string, index: number): PendingReply | null =>
        state.replies[key(networkId, target)]?.[index] ?? null,
  },
  actions: {
    seed(
      networkId: number | string,
      target: string,
      entries: string[],
      replies?: Array<PendingReply | null>,
    ) {
      if (!Array.isArray(entries)) return;
      const k = key(networkId, target);
      this.history[k] = entries.slice();
      if (replies?.some(Boolean)) this.replies[k] = replies.slice(0, entries.length);
      else delete this.replies[k];
    },
    add(
      networkId: number | string,
      target: string,
      text: string,
      reply: PendingReply | null = null,
    ) {
      if (!text) return;
      const k = key(networkId, target);
      const arr = this.history[k] || [];
      this.history[k] = [...arr, text];
      const replies = this.replies[k];
      if (reply || replies) {
        const aligned = replies ?? Array.from({ length: arr.length }, () => null);
        this.replies[k] = [...aligned, reply];
      }
    },
    drop(networkId: number | string, target: string) {
      delete this.history[key(networkId, target)];
      delete this.replies[key(networkId, target)];
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts).
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return;
      this.drop(networkId, target);
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const fromKey = key(networkId, from);
      const toKey = key(networkId, to);
      if (!this.history[fromKey]) return;
      // Destination wins on a merge collision; the source mirror is dropped
      // (the server's merged slice re-seeds on next open anyway).
      if (!this.history[toKey]) {
        this.history[toKey] = this.history[fromKey];
        if (this.replies[fromKey]) this.replies[toKey] = this.replies[fromKey];
      }
      delete this.history[fromKey];
      delete this.replies[fromKey];
    },
  },
});
