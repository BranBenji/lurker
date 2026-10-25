// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The thread panel (#1225) on its routes: what it asks for, what it draws for a
// thread (first line, count, replies, the quote only off the first line), the
// list mode, and the Reply pick that steers its composer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import ThreadPanel from './ThreadPanel.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useThreadsStore } from '../stores/threads.js';
import type { ThreadMessage } from '../stores/threads.js';
import { socketSend } from '../composables/useSocket.js';
import * as threadNav from '../composables/useThreadNav.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<{ ok: boolean }>>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;
let router: Router;

function line(id: number, over: Record<string, unknown> = {}): ThreadMessage {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick: 'alice',
    text: `line ${id}`,
    msgid: `m${id}`,
    userhost: 'alice!~a@host',
    time: new Date(Date.UTC(2026, 9, 24, 12, id)).toISOString(),
    ...over,
  } as ThreadMessage;
}

function seed() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', canReply: true } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.members = [{ nick: 'alice', modes: [], away: false }];
  networks.activeKey = '1::#chan';
}

async function mountAt(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/buffer/:id', name: 'buffer', component: { template: '<div />' } },
      {
        path: '/buffer/:id/thread/:root',
        name: 'buffer-thread',
        component: { template: '<div />' },
      },
      { path: '/buffer/:id/threads', name: 'buffer-threads', component: { template: '<div />' } },
    ],
  });
  await router.push(path);
  wrapper = mount(ThreadPanel, { attachTo: document.body, global: { plugins: [router] } });
  await wrapper.vm.$nextTick();
  return wrapper;
}

const sent = () => vi.mocked(socketSend).mock.calls.map((c) => c[0]);

describe('ThreadPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
  });

  it('asks for the thread its route names and draws it: first line, count, replies', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    expect(sent()[0]).toMatchObject({ type: 'thread', bufferId: 9, rootMsgid: 'm1' });
    expect(w.text()).toContain('loading thread');

    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1, { text: 'anyone around?' }),
      replies: [
        line(2, {
          nick: 'bob',
          text: 'alice: here',
          replyTo: { msgid: 'm1', root: 'm1', parent: null },
        }),
        line(3, {
          nick: 'carol',
          text: 'bob: me too',
          replyTo: {
            msgid: 'm2',
            root: 'm1',
            parent: {
              id: 2,
              nick: 'bob',
              type: 'message',
              text: 'alice: here',
              userhost: null,
              self: false,
            },
          },
        }),
      ],
    });
    await w.vm.$nextTick();
    const rows = w.findAll('.t-line');
    expect(rows).toHaveLength(3);
    expect(rows[0].classes()).toContain('root');
    expect(rows[0].text()).toContain('anyone around?');
    expect(w.find('.rule').text()).toBe('2 replies');
    // The address the thread makes redundant is dropped; a reply to the first
    // line has no quote, a reply to another reply quotes it.
    expect(rows[1].text()).toContain('here');
    expect(rows[1].text()).not.toContain('alice: here');
    expect(rows[1].find('.reply-quote').exists()).toBe(false);
    expect(rows[2].find('.reply-quote').exists()).toBe(true);
    expect(rows[2].find('.reply-quote').text()).toContain('<bob>');

    // A live reply lands at the end.
    threads.applyLive(
      line(4, { nick: 'dave', replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
    );
    await w.vm.$nextTick();
    expect(w.findAll('.t-line')).toHaveLength(4);
    expect(w.find('.rule').text()).toBe('3 replies');
  });

  it('says so when the first line is gone, and Reply on a line steers the composer', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: null,
      replies: [line(2, { nick: 'bob', replyTo: { msgid: 'm1', root: 'm1', parent: null } })],
    });
    await w.vm.$nextTick();
    expect(w.find('.t-line.missing').text()).toContain('original message unavailable');
    expect(w.find('.thread-composer .replying').text()).toBe('Replying in thread');

    const reply = w.findAll('.row-action').find((b) => b.attributes('title') === 'Reply to bob');
    expect(reply).toBeTruthy();
    await reply!.trigger('click');
    expect(threads.pending).toMatchObject({ messageId: 2, nick: 'bob' });
    expect(w.find('[data-msg-id="2"]').classes()).toContain('replying');
    expect(w.find('.thread-composer .replying').text()).toContain('bob');
    // Quote isn't offered: a send from here already carries a reply tag.
    expect(w.findAll('.row-action').some((b) => b.attributes('title')?.startsWith('Quote'))).toBe(
      false,
    );
  });

  it('the list route asks for the buffer’s threads and opens one on click', async () => {
    seed();
    const w = await mountAt('/buffer/9/threads');
    const threads = useThreadsStore();
    expect(sent()[0]).toMatchObject({ type: 'threads', bufferId: 9 });
    expect(w.find('.panel-title').text()).toBe('Threads');
    threads.applyList({
      bufferId: 9,
      token: threads.list!.token,
      threads: [
        {
          rootMsgid: 'm1',
          root: {
            id: 1,
            nick: 'alice',
            type: 'message',
            text: 'anyone?',
            userhost: null,
            self: false,
          },
          replies: 2,
          lastReplyId: 3,
          lastReplyTime: new Date().toISOString(),
        },
      ],
    });
    await w.vm.$nextTick();
    const row = w.find('.thread-list .row');
    expect(row.text()).toContain('anyone?');
    expect(row.text()).toContain('2 replies');
    const nav = vi.spyOn(threadNav, 'requestThreadNav');
    await row.trigger('click');
    expect(nav).toHaveBeenCalledWith({ kind: 'thread', bufferId: 9, rootMsgid: 'm1' });
  });

  it('× asks to close; the view goes with the panel', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const nav = vi.spyOn(threadNav, 'requestThreadNav');
    await w.find('.panel-head .close').trigger('click');
    expect(nav).toHaveBeenCalledWith({ kind: 'close', bufferId: 9 });
    w.unmount();
    wrapper = null;
    expect(useThreadsStore().view).toBeNull();
  });
});
