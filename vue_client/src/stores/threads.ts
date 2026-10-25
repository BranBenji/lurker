// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { requestThreadNav } from '../composables/useThreadNav.js';
import { useBuffersStore } from './buffers.js';
import type { BufferMessage } from './buffers.js';
import type { ReplyContext, ReplyParent, ThreadStats } from '../../../shared/replies.js';

// Reply threads (#1225): a thread is the line that started it plus every reply
// naming it as root (`replyTo.root`), in one buffer. With `chat.threads` on,
// the message list keeps the replies out and the thread panel shows them.
//
// Three tracks:
//   - `followed` is the server's list of threads the user is in (posted, was
//     highlighted, or started), each with its own unread count. It arrives
//     whole in `threads-changed` — at connect and after every change — so no
//     count is ever kept here. It is what tints a chip.
//   - `view` is the thread on screen: loaded whole with a `thread` request
//     when the panel opens, then kept current from the live `irc` frames whose
//     root is its root.
//   - `list` is the buffer's threads for the panel's list mode (`threads`).

export interface FollowedThread {
  networkId: number;
  bufferId: number;
  target: string;
  rootMsgid: string;
  root: Omit<ReplyParent, 'self'> | null;
  unread: number;
  highlighted: boolean;
  lastReplyId: number;
  lastReplyTime: string;
}

// A line as the panel holds it: a buffer row with the fields it reads spelled out.
export interface ThreadMessage extends BufferMessage {
  id: number;
  msgid?: string;
  text?: string;
  time?: string;
  replyTo?: ReplyContext;
  thread?: ThreadStats;
}

export interface ThreadView {
  networkId: number;
  target: string;
  bufferId: number;
  rootMsgid: string;
  // null until loaded, and after when we don't hold the first line.
  root: ThreadMessage | null;
  replies: ThreadMessage[];
  loading: boolean;
  truncated: boolean;
  token: number;
}

export interface BufferThread {
  rootMsgid: string;
  root: ReplyParent | null;
  replies: number;
  lastReplyId: number;
  lastReplyTime: string;
}

export interface ThreadList {
  bufferId: number;
  threads: BufferThread[];
  loading: boolean;
  token: number;
}

// The line a send from the panel answers (replyTarget).
export interface ThreadReplyTarget {
  messageId: number;
  nick: string;
  type: string;
  text: string;
  self: boolean;
}

let nextToken = 1;

// Most replies the panel holds live (#1225): the `thread` read ships the
// newest THREAD_MAX_REPLIES, and live replies past that drop the oldest, so a
// panel left open under a bridge stays this size. The server's cap is the same.
export const THREAD_MAX_REPLIES = 1000;

export function threadKey(bufferId: number, rootMsgid: string): string {
  return `${bufferId}|${rootMsgid}`;
}

export const useThreadsStore = defineStore('threads', {
  state: () => ({
    followed: [] as FollowedThread[],
    view: null as ThreadView | null,
    list: null as ThreadList | null,
    // Set by a Reply in the channel (replyFromChannel): the panel puts the
    // caret in its composer once the thread is up, then clears this.
    wantComposer: false,
  }),
  getters: {
    // The followed list by thread, built once per list — the message list asks
    // per chip per render.
    followedByKey: (state): Map<string, FollowedThread> => {
      const map = new Map<string, FollowedThread>();
      for (const t of state.followed) map.set(threadKey(t.bufferId, t.rootMsgid), t);
      return map;
    },
    followedFor() {
      return (bufferId: number, rootMsgid: string): FollowedThread | null =>
        this.followedByKey.get(threadKey(bufferId, rootMsgid)) ?? null;
    },
    // Threads in a buffer with a highlight the user hasn't seen: what lights
    // the Threads button in the header, since the channel's list hides the
    // reply itself.
    highlightedThreadsFor:
      (state) =>
      (bufferId: number | null | undefined): number =>
        bufferId == null
          ? 0
          : state.followed.filter((t) => t.bufferId === bufferId && t.unread > 0 && t.highlighted)
              .length,
    // The server's unread count for a thread; 0 when it isn't followed.
    unreadFor() {
      return (bufferId: number, rootMsgid: string): number =>
        this.followedByKey.get(threadKey(bufferId, rootMsgid))?.unread ?? 0;
    },
  },
  actions: {
    applyFollowed(list: FollowedThread[]) {
      this.followed = Array.isArray(list) ? list : [];
    },

    // Open the panel on (bufferId, rootMsgid): ask for the thread whole.
    // Re-opening the one already loaded keeps what's there and refreshes it
    // underneath.
    open(bufferId: number, rootMsgid: string) {
      const buf = useBuffersStore().byId(bufferId);
      if (!buf || buf.networkId == null) return;
      const token = nextToken++;
      const same = this.view?.bufferId === bufferId && this.view.rootMsgid === rootMsgid;
      this.view = {
        networkId: Number(buf.networkId),
        target: buf.target,
        bufferId,
        rootMsgid,
        root: same ? this.view!.root : null,
        replies: same ? this.view!.replies : [],
        loading: !same,
        truncated: same ? this.view!.truncated : false,
        token,
      };
      socketSend({ type: 'thread', bufferId, rootMsgid, token });
    },

    close() {
      this.view = null;
    },

    // The `thread` answer. Dropped unless it answers the request on screen.
    applyThread(frame: {
      bufferId: number | null;
      rootMsgid: string | null;
      token?: number | null;
      root: ThreadMessage | null;
      replies: ThreadMessage[];
      truncated?: boolean;
    }) {
      const v = this.view;
      if (!v || v.bufferId !== frame.bufferId || v.rootMsgid !== frame.rootMsgid) return;
      if (frame.token != null && frame.token !== v.token) return;
      v.root = frame.root ?? null;
      // Live replies that landed between the request and this answer stay.
      const replies = Array.isArray(frame.replies) ? frame.replies : [];
      const ids = new Set(replies.map((r) => r.id));
      const newest = replies.at(-1)?.id ?? 0;
      const late = v.replies.filter((r) => !ids.has(r.id) && r.id > newest);
      v.replies = [...replies, ...late];
      v.truncated = !!frame.truncated;
      v.loading = false;
    },

    // The panel's list mode: the buffer's threads.
    openList(bufferId: number) {
      const token = nextToken++;
      const same = this.list?.bufferId === bufferId;
      this.list = {
        bufferId,
        threads: same ? this.list!.threads : [],
        loading: !same,
        token,
      };
      socketSend({ type: 'threads', bufferId, token });
    },

    closeList() {
      this.list = null;
    },

    applyList(frame: { bufferId: number; token?: number | null; threads: BufferThread[] }) {
      const l = this.list;
      if (!l || l.bufferId !== frame.bufferId) return;
      if (frame.token != null && frame.token !== l.token) return;
      l.threads = Array.isArray(frame.threads) ? frame.threads : [];
      l.loading = false;
    },

    // A live line. Joins the thread on screen when its root is the view's; and
    // wherever its root line is loaded — in the channel, or as the view's own
    // first line — that line's chip counts it. Someone ignored doesn't count
    // (the server's count leaves them out), nor a replay.
    applyLive(event: ThreadMessage) {
      const root = event.replyTo?.root;
      if (!root || event.id == null || typeof event.bufferId !== 'number') return;
      const v = this.view;
      const inView = v && v.bufferId === event.bufferId && v.rootMsgid === root;
      if (inView) {
        if (v.replies.some((r) => r.id === event.id)) return;
        v.replies.push(event);
        if (v.replies.length > THREAD_MAX_REPLIES) {
          v.replies.splice(0, v.replies.length - THREAD_MAX_REPLIES);
          v.truncated = true;
        }
      }
      if (event.fromIgnored) return;
      const bump = (line: ThreadMessage | undefined) => {
        if (!line) return;
        line.thread = {
          replies: (line.thread?.replies ?? 0) + 1,
          lastReplyTime: String(event.time ?? line.thread?.lastReplyTime ?? ''),
        };
      };
      if (inView && v.root) bump(v.root);
      // The line carrying that msgid is the root by definition.
      const buf = useBuffersStore().byId(event.bufferId);
      bump(buf?.messages.find((m) => m.msgid === root) as ThreadMessage | undefined);
      // And the list, if it's up for this buffer.
      const l = this.list;
      if (l && l.bufferId === event.bufferId) {
        const entry = l.threads.find((t) => t.rootMsgid === root);
        if (entry) {
          entry.replies += 1;
          entry.lastReplyId = event.id;
          entry.lastReplyTime = String(event.time ?? entry.lastReplyTime);
          l.threads.sort((a, b) => b.lastReplyId - a.lastReplyId);
        } else {
          l.threads.unshift({
            rootMsgid: root,
            root: event.replyTo?.parent ?? null,
            replies: 1,
            lastReplyId: event.id,
            lastReplyTime: String(event.time ?? ''),
          });
        }
      }
    },

    // The panel has shown every reply it holds: move the server's read
    // pointer, if the thread is one we follow (only those have one).
    markViewRead() {
      const v = this.view;
      if (!v || v.loading) return;
      const followed = this.followedFor(v.bufferId, v.rootMsgid);
      const last = v.replies.at(-1);
      if (!last || !followed || followed.unread === 0) return;
      socketSend({
        type: 'thread-read',
        bufferId: v.bufferId,
        rootMsgid: v.rootMsgid,
        messageId: last.id,
      });
    },

    // Reply on a channel line with threads on: open its thread with the caret
    // in the panel's composer.
    replyFromChannel(bufferId: number, rootMsgid: string) {
      const same = this.view?.bufferId === bufferId && this.view.rootMsgid === rootMsgid;
      this.wantComposer = true;
      if (same) return;
      requestThreadNav({ kind: 'thread', bufferId, rootMsgid });
    },

    // What a send from the panel answers: the newest reply from someone else,
    // so that in a client without threads the thread reads as the conversation
    // it is (each line quoting, and addressing, the one it answers) rather than
    // every line quoting the first; else the first line; else — when we don't
    // hold it — the oldest reply we do. A line a reply tag can't name (no
    // msgid, encrypted) is skipped; someone ignored is never answered.
    replyTarget(): ThreadReplyTarget | null {
      const v = this.view;
      if (!v) return null;
      const usable = (m: ThreadMessage | null | undefined): m is ThreadMessage =>
        !!m && !!m.msgid && !m.e2e;
      const theirs = v.replies.filter((r) => !r.self && !r.fromIgnored && usable(r));
      const line = theirs.at(-1) ?? (usable(v.root) ? v.root : null) ?? v.replies.find(usable);
      if (!line) return null;
      return {
        messageId: line.id,
        nick: String(line.nick ?? ''),
        type: line.type,
        text: String(line.text ?? ''),
        self: !!line.self,
      };
    },
  },
});
