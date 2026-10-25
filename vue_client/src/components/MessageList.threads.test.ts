// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Reply threads in the message list (#1225): with the setting on, replies stay
// out of the list and the line that started a thread wears a chip that opens
// it; a jump onto a hidden reply opens its thread instead. Off, nothing changes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useThreadsStore } from '../stores/threads.js';
import * as threadNav from '../composables/useThreadNav.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;
let nextId = 1;

function line(nick: string, text: string, extra: Record<string, unknown> = {}) {
  const id = nextId++;
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick,
    text,
    userhost: `${nick}!~u@host`,
    time: new Date(Date.UTC(2026, 9, 24, 12, id)).toISOString(),
    self: nick === 'me',
    ...extra,
  };
}

function mountWith(
  messages: Record<string, unknown>[],
  opts: { threads?: boolean; pendingScrollId?: number | null; target?: string } = {},
) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const target = opts.target ?? '#chan';
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, target, 9);
  b.messages = messages as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = `1::${target}`;
  if (opts.threads) useSettingsStore().values['chat.threads'] = true;
  wrapper = mount(MessageList, {
    attachTo: document.body,
    props: { pendingScrollId: opts.pendingScrollId ?? null },
  });
  return wrapper;
}

const rowOf = (w: VueWrapper, id: number) => w.find(`[data-msg-id="${id}"]`);

describe('MessageList — reply threads', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
  });

  it('off: replies show inline, no chip', () => {
    const root = line('alice', 'anyone?', {
      msgid: 'm1',
      thread: { replies: 1, lastReplyTime: 't' },
    });
    const reply = line('bob', 'alice: me', { replyTo: { msgid: 'm1', root: 'm1', parent: null } });
    const w = mountWith([root, reply]);
    expect(rowOf(w, reply.id).exists()).toBe(true);
    expect(w.find('.thread-chip').exists()).toBe(false);
  });

  it('on: a reply with a root is kept out; its first line wears the chip, accent when unread', async () => {
    const root = line('alice', 'anyone?', {
      msgid: 'm1',
      thread: { replies: 2, lastReplyTime: 't' },
    });
    const reply = line('bob', 'alice: me', { replyTo: { msgid: 'm1', root: 'm1', parent: null } });
    // Stored before roots were tracked: still a channel line, with its quote.
    const old = line('carol', 'alice: me too', { replyTo: { msgid: 'm1', parent: null } });
    const plain = line('dave', 'unrelated');
    const w = mountWith([root, reply, old, plain], { threads: true });
    expect(rowOf(w, reply.id).exists()).toBe(false);
    expect(rowOf(w, old.id).exists()).toBe(true);
    expect(rowOf(w, plain.id).exists()).toBe(true);
    const chip = rowOf(w, root.id).find('.thread-chip');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('2 replies');
    expect(chip.classes()).not.toContain('unread');

    const nav = vi.spyOn(threadNav, 'requestThreadNav');
    await chip.trigger('click');
    expect(nav).toHaveBeenCalledWith({ kind: 'thread', bufferId: 9, rootMsgid: 'm1' });

    useThreadsStore().applyFollowed([
      {
        networkId: 1,
        bufferId: 9,
        target: '#chan',
        rootMsgid: 'm1',
        root: null,
        unread: 1,
        highlighted: false,
        lastReplyId: 2,
        lastReplyTime: 't',
      },
    ]);
    await w.vm.$nextTick();
    expect(rowOf(w, root.id).find('.thread-chip').classes()).toContain('unread');
  });

  it('on: a highlighted reply is kept in its thread too', () => {
    const root = line('alice', 'anyone?', {
      msgid: 'm1',
      thread: { replies: 2, lastReplyTime: 't' },
    });
    const mention = line('bob', 'me: you around?', {
      matched: true,
      replyTo: { msgid: 'm1', root: 'm1', parent: null },
    });
    const toMe = line('carol', 'me: yes', {
      replyToSelf: true,
      replyTo: { msgid: 'm1', root: 'm1', parent: null },
    });
    const w = mountWith([root, mention, toMe], { threads: true });
    expect(rowOf(w, mention.id).exists()).toBe(false);
    expect(rowOf(w, toMe.id).exists()).toBe(false);
    expect(rowOf(w, root.id).find('.thread-chip').exists()).toBe(true);
  });

  it('on: a DM keeps every reply and wears no chip', () => {
    const root = line('alice', 'hi', {
      target: 'alice',
      msgid: 'm1',
      thread: { replies: 1, lastReplyTime: 't' },
    });
    const reply = line('alice', 'and hi again', {
      target: 'alice',
      replyTo: { msgid: 'm1', root: 'm1', parent: null },
    });
    const w = mountWith([root, reply], { threads: true, target: 'alice' });
    expect(rowOf(w, reply.id).exists()).toBe(true);
    expect(w.find('.thread-chip').exists()).toBe(false);
  });

  it('on: Reply in the channel opens the line’s thread with the composer wanted', async () => {
    const root = line('alice', 'anyone?', {
      msgid: 'm1',
      thread: { replies: 1, lastReplyTime: 't' },
    });
    const w = mountWith([root], { threads: true });
    const nav = vi.spyOn(threadNav, 'requestThreadNav');
    const threads = useThreadsStore();
    const btn = rowOf(w, root.id)
      .findAll('.row-action')
      .find((b) => b.attributes('title')?.startsWith('Reply to '));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    expect(nav).toHaveBeenLastCalledWith({ kind: 'thread', bufferId: 9, rootMsgid: 'm1' });
    expect(threads.wantComposer).toBe(true);
  });

  it('on: a jump onto a hidden reply opens its thread on that reply', async () => {
    const root = line('alice', 'anyone?', {
      msgid: 'm1',
      thread: { replies: 1, lastReplyTime: 't' },
    });
    const reply = line('bob', 'alice: me', { replyTo: { msgid: 'm1', root: 'm1', parent: null } });
    const nav = vi.spyOn(threadNav, 'requestThreadNav');
    const w = mountWith([root, reply], { threads: true });
    await w.setProps({ pendingScrollId: reply.id });
    await w.vm.$nextTick();
    expect(nav).toHaveBeenCalledWith({
      kind: 'thread',
      bufferId: 9,
      rootMsgid: 'm1',
      focusId: reply.id,
    });
    // A jump onto a shown line asks for nothing.
    nav.mockClear();
    await w.setProps({ pendingScrollId: root.id });
    await w.vm.$nextTick();
    expect(nav).not.toHaveBeenCalled();
  });
});
