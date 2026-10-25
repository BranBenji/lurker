// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The threads store (#1225): what a `thread` answer becomes, how a live reply
// joins the thread on screen and bumps its first line's chip, and what a send
// from the panel answers.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { THREAD_MAX_REPLIES, useThreadsStore } from './threads.js';
import type { ThreadMessage } from './threads.js';
import { useBuffersStore } from './buffers.js';
import { socketSend } from '../composables/useSocket.js';
import * as threadNav from '../composables/useThreadNav.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const sent = () => vi.mocked(socketSend).mock.calls.map((c) => c[0]);

function line(id: number, over: Record<string, unknown> = {}): ThreadMessage {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick: 'alice',
    text: `line ${id}`,
    time: new Date(Date.UTC(2026, 9, 24, 12, id)).toISOString(),
    ...over,
  } as ThreadMessage;
}

function seed(messages: ThreadMessage[] = []) {
  const buffers = useBuffersStore();
  const b = buffers.ensure(1, '#chan', 9);
  b.messages = messages as never;
  return b;
}

describe('threads store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });

  it('open asks for the thread and applies the answer with its token', () => {
    seed();
    const threads = useThreadsStore();
    threads.open(9, 'root');
    const token = threads.view!.token;
    expect(sent()).toEqual([{ type: 'thread', bufferId: 9, rootMsgid: 'root', token }]);
    expect(threads.view).toMatchObject({ bufferId: 9, rootMsgid: 'root', loading: true });

    // A stale answer (another token) is dropped; the right one lands.
    threads.applyThread({ bufferId: 9, rootMsgid: 'root', token: -1, root: null, replies: [] });
    expect(threads.view?.loading).toBe(true);
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'root',
      token,
      root: line(1, { msgid: 'root', thread: { replies: 1, lastReplyTime: 't' } }),
      replies: [line(2, { replyTo: { msgid: 'root', root: 'root', parent: null } })],
      truncated: false,
    });
    expect(threads.view).toMatchObject({ loading: false, root: { id: 1 } });
    expect(threads.view?.replies.map((r) => r.id)).toEqual([2]);
  });

  it('a live reply joins the open thread once and bumps the chips that name its root', () => {
    const root = line(1, { msgid: 'root', thread: { replies: 1, lastReplyTime: 'old' } });
    seed([root]);
    const threads = useThreadsStore();
    threads.open(9, 'root');
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'root',
      token: threads.view!.token,
      root: { ...root },
      replies: [line(2, { replyTo: { msgid: 'root', root: 'root', parent: null } })],
    });
    const reply = line(3, { nick: 'bob', replyTo: { msgid: 'root', root: 'root', parent: null } });
    threads.applyLive(reply);
    threads.applyLive(reply); // a replay
    expect(threads.view?.replies.map((r) => r.id)).toEqual([2, 3]);
    expect(threads.view?.root?.thread).toEqual({ replies: 2, lastReplyTime: reply.time });
    // The channel's copy of the first line too, where the chip is drawn.
    const inChannel = useBuffersStore().byId(9)!.messages[0] as ThreadMessage;
    expect(inChannel.thread).toEqual({ replies: 2, lastReplyTime: reply.time });
    // Someone ignored joins the thread (it keeps its shape) but counts for nothing.
    threads.applyLive(
      line(4, {
        nick: 'troll',
        fromIgnored: true,
        replyTo: { msgid: 'root', root: 'root', parent: null },
      }),
    );
    expect(threads.view?.replies).toHaveLength(3);
    expect(inChannel.thread?.replies).toBe(2);
  });

  it('keeps the live slice to the server’s cap, dropping the oldest and saying so', () => {
    seed();
    const threads = useThreadsStore();
    threads.open(9, 'root');
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'root',
      token: threads.view!.token,
      root: null,
      replies: Array.from({ length: THREAD_MAX_REPLIES }, (_, i) =>
        line(i + 10, { replyTo: { msgid: 'root', root: 'root', parent: null } }),
      ),
    });
    threads.applyLive(line(5000, { replyTo: { msgid: 'root', root: 'root', parent: null } }));
    expect(threads.view?.replies).toHaveLength(THREAD_MAX_REPLIES);
    expect(threads.view?.replies[0].id).toBe(11);
    expect(threads.view?.replies.at(-1)?.id).toBe(5000);
    expect(threads.view?.truncated).toBe(true);
  });

  it('replyFromChannel asks for the thread and keeps the pick through the open', () => {
    seed();
    const threads = useThreadsStore();
    const nav = vi.spyOn(threadNav, 'requestThreadNav');
    threads.replyFromChannel(9, 'root', { id: 7, nick: 'bob', type: 'message', text: 'x' });
    expect(nav).toHaveBeenCalledWith({ kind: 'thread', bufferId: 9, rootMsgid: 'root' });
    expect(threads.wantComposer).toBe(true);
    // The shell navigates, the panel opens the thread: the pick is still there.
    threads.open(9, 'root');
    expect(threads.pending).toMatchObject({ messageId: 7, nick: 'bob' });
    // Already on that thread: no navigation, just the pick and the caret.
    nav.mockClear();
    threads.wantComposer = false;
    threads.replyFromChannel(9, 'root', null);
    expect(nav).not.toHaveBeenCalled();
    expect(threads.pending).toBeNull();
    expect(threads.wantComposer).toBe(true);
  });

  it('a reply to another thread leaves the open one alone', () => {
    seed([line(1, { msgid: 'root' }), line(5, { msgid: 'other' })]);
    const threads = useThreadsStore();
    threads.open(9, 'root');
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'root',
      token: threads.view!.token,
      root: null,
      replies: [],
    });
    threads.applyLive(line(6, { replyTo: { msgid: 'other', root: 'other', parent: null } }));
    expect(threads.view?.replies).toEqual([]);
    const other = useBuffersStore().byId(9)!.messages[1] as ThreadMessage;
    expect(other.thread?.replies).toBe(1);
  });

  it('replyTarget is the picked line, else the first line, else the oldest reply held', () => {
    seed();
    const threads = useThreadsStore();
    threads.open(9, 'root');
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'root',
      token: threads.view!.token,
      root: null,
      replies: [
        line(2, {
          msgid: 'r2',
          nick: 'bob',
          replyTo: { msgid: 'root', root: 'root', parent: null },
        }),
        line(3, { msgid: 'r3', replyTo: { msgid: 'r2', root: 'root', parent: null } }),
      ],
    });
    expect(threads.replyTarget()).toMatchObject({ messageId: 2, nick: 'bob' });
    threads.setPending({ messageId: 3, nick: 'alice', type: 'message', text: 'x', self: false });
    expect(threads.replyTarget()).toMatchObject({ messageId: 3 });
    // Opening another thread drops the pick.
    threads.open(9, 'elsewhere');
    expect(threads.pending).toBeNull();
  });

  it('markViewRead moves the pointer of a followed thread with something unread, once', () => {
    seed();
    const threads = useThreadsStore();
    threads.open(9, 'root');
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'root',
      token: threads.view!.token,
      root: null,
      replies: [line(2, { replyTo: { msgid: 'root', root: 'root', parent: null } })],
    });
    vi.mocked(socketSend).mockClear();
    // Not followed: nothing to move.
    threads.markViewRead();
    expect(sent()).toEqual([]);
    threads.applyFollowed([
      {
        networkId: 1,
        bufferId: 9,
        target: '#chan',
        rootMsgid: 'root',
        root: null,
        unread: 1,
        highlighted: false,
        lastReplyId: 2,
        lastReplyTime: 't',
      },
    ]);
    threads.markViewRead();
    expect(sent()).toEqual([{ type: 'thread-read', bufferId: 9, rootMsgid: 'root', messageId: 2 }]);
    expect(threads.unreadFor(9, 'root')).toBe(1);
    expect(threads.unreadFor(9, 'nope')).toBe(0);
  });

  it('the list applies its answer and a live reply moves its thread to the top', () => {
    seed();
    const threads = useThreadsStore();
    threads.openList(9);
    expect(sent()).toEqual([{ type: 'threads', bufferId: 9, token: threads.list!.token }]);
    threads.applyList({
      bufferId: 9,
      token: threads.list!.token,
      threads: [
        { rootMsgid: 'a', root: null, replies: 2, lastReplyId: 5, lastReplyTime: 't' },
        { rootMsgid: 'b', root: null, replies: 1, lastReplyId: 4, lastReplyTime: 't' },
      ],
    });
    threads.applyLive(line(7, { replyTo: { msgid: 'b', root: 'b', parent: null } }));
    expect(threads.list?.threads.map((t) => [t.rootMsgid, t.replies])).toEqual([
      ['b', 2],
      ['a', 2],
    ]);
    // A thread not yet listed appears.
    threads.applyLive(line(8, { replyTo: { msgid: 'c', root: 'c', parent: null } }));
    expect(threads.list?.threads[0]).toMatchObject({ rootMsgid: 'c', replies: 1 });
  });
});
