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
import { useSettingsStore } from '../stores/settings.js';
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
    // The address the thread makes redundant is dropped; neither a reply to the
    // first line nor one to the line just above carries a quote (the quote test
    // below covers an answer to an earlier line).
    expect(rows[1].text()).toContain('here');
    expect(rows[1].text()).not.toContain('alice: here');
    expect(rows[1].find('.reply-quote').exists()).toBe(false);
    expect(rows[2].find('.reply-quote').exists()).toBe(false);

    // A live reply lands at the end.
    threads.applyLive(
      line(4, { nick: 'dave', replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
    );
    await w.vm.$nextTick();
    expect(w.findAll('.t-line')).toHaveLength(4);
    expect(w.find('.rule').text()).toBe('3 replies');
  });

  it('says so when the first line is gone, and offers neither Reply nor Quote on a line', async () => {
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
    // The status row holds only the paperclip, as the main status bar does.
    expect(w.find('.panel-status').text()).toBe('');
    expect(w.find('.panel-status .tool-btn').exists()).toBe(true);
    // A send from here answers the newest reply from someone else; picking a
    // line would undo that, and Quote would ride a send that carries a reply
    // tag. The rest of the bar is there.
    const titles = w.findAll('.row-action').map((b) => b.attributes('title') ?? '');
    expect(titles.some((t) => t.startsWith('Reply to'))).toBe(false);
    expect(titles.some((t) => t.startsWith('Quote'))).toBe(false);
    expect(titles).toContain('Copy text');
  });

  it('quotes only an answer to an earlier line, not to the first or the one just above', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    const reply = (id: number, nick: string, to: string, text: string) =>
      line(id, {
        nick,
        text,
        replyTo: {
          msgid: to,
          root: 'm1',
          parent: {
            id: Number(to.slice(1)),
            nick: 'x',
            type: 'message',
            text,
            userhost: null,
            self: false,
          },
        },
      });
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1),
      replies: [
        reply(2, 'bob', 'm1', 'to the first line'),
        reply(3, 'carol', 'm2', 'to the one just above'),
        reply(4, 'dave', 'm2', 'back to an earlier one'),
      ],
    });
    await w.vm.$nextTick();
    expect(w.find('[data-msg-id="2"] .reply-quote').exists()).toBe(false);
    expect(w.find('[data-msg-id="3"] .reply-quote').exists()).toBe(false);
    expect(w.find('[data-msg-id="4"] .reply-quote').exists()).toBe(true);
  });

  it('rows follow the message layout: compact by default here, standard on request', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    const at = (min: number) => new Date(Date.UTC(2026, 9, 24, 12, min)).toISOString();
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1, { time: at(0) }),
      replies: [
        line(2, { nick: 'bob', time: at(1), replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
        line(3, { nick: 'bob', time: at(2), replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
        line(4, { nick: 'carol', time: at(3), replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
      ],
    });
    await w.vm.$nextTick();
    // `auto` (the default) is compact in the panel: a head per speaker run.
    expect(w.find('.lines').classes()).toContain('compact');
    expect(w.find('[data-msg-id="2"] .head').exists()).toBe(true);
    expect(w.find('[data-msg-id="3"] .head').exists()).toBe(false);
    expect(w.find('[data-msg-id="3"]').classes()).toContain('cont');
    expect(w.find('[data-msg-id="4"] .head').exists()).toBe(true);

    useSettingsStore().values['look.message.layout'] = 'standard';
    await w.vm.$nextTick();
    expect(w.find('.lines').classes()).toContain('standard');
    expect(w.find('[data-msg-id="3"] .head').exists()).toBe(false);
    expect(w.find('[data-msg-id="3"] .prefix').text()).toBe('bob');
    expect(w.find('[data-msg-id="3"]').classes()).not.toContain('cont');
  });

  it('counts and tints by today’s rules: an ignored sender’s reply is out of the count', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1),
      replies: [
        line(2, { nick: 'bob', replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
        line(3, {
          nick: 'troll',
          fromIgnored: true,
          replyTo: { msgid: 'm1', root: 'm1', parent: null },
        }),
        line(4, {
          nick: 'dave',
          matched: true,
          replyTo: { msgid: 'm1', root: 'm1', parent: null },
        }),
      ],
    });
    await w.vm.$nextTick();
    expect(w.find('.rule').text()).toBe('2 replies');
    expect(w.find('[data-msg-id="3"]').text()).toContain('(ignored)');
    // The stamp tints until the rules are loaded; then the rules decide.
    expect(w.find('[data-msg-id="4"]').classes()).toContain('highlight');
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
