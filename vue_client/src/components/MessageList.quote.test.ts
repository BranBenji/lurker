// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A `> …` line in a message (#1119) through the real MessageList: drawn as a
// block quote with the mark gone, the answer under it plain.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

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
    time: new Date(Date.UTC(2026, 8, 25, 12, id)).toISOString(),
    self: nick === 'me',
    ...extra,
  };
}

function mountWith(messages: Record<string, unknown>[]) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.messages = messages as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return wrapper;
}

const rowOf = (w: VueWrapper, id: number) => w.find(`[data-msg-id="${id}"]`);

describe('MessageList — block quotes', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('draws a quote line as a block and the answer under it as text', () => {
    const m = line('bob', '> <alice> what \x02time\x02 is it?\nnoon');
    const row = rowOf(mountWith([m]), m.id);
    const quote = row.find('.body .msg-quote');
    expect(quote.text()).toBe('<alice> what time is it?');
    expect(quote.find('span[style]').text()).toBe('time');
    expect(row.find('.body').text().replace(quote.text(), '').trim()).toBe('noon');
  });

  // On a network without draft/multiline the quote and the answer are two
  // messages, and only the first is a quote.
  it('quotes a line of its own, and leaves the next line alone', () => {
    const q = line('bob', '> <alice> hi');
    const a = line('bob', 'hi yourself');
    const w = mountWith([q, a]);
    expect(rowOf(w, q.id).find('.msg-quote').text()).toBe('<alice> hi');
    expect(rowOf(w, a.id).find('.msg-quote').exists()).toBe(false);
  });

  // Only a message quotes: a notice is a service's text (`> help` is HelpServ's
  // own mark), an action is prose with the author in front.
  it('does not quote greentext, an action, or a notice', () => {
    const green = line('bob', '>implying');
    const act = line('bob', '> waves\n> again', { type: 'action' });
    const note = line('HelpServ', '> help\n> list', { type: 'notice' });
    const w = mountWith([green, act, note]);
    for (const m of [green, act, note]) {
      expect(rowOf(w, m.id).find('.msg-quote').exists()).toBe(false);
    }
    expect(rowOf(w, act.id).find('.body').text()).toBe('bob > waves\n> again');
    expect(rowOf(w, note.id).find('.body').text()).toBe('> help\n> list');
  });
});
