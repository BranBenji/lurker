// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The unread divider and a line the list hides. Entered with nothing unread
// because the newest line was an ignored sender's (it never counted), the
// boundary sits under that hidden line; the user's own next line used to be
// the first visible row past it, and the divider landed over it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useIgnoresStore } from '../stores/ignores.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

const line = (id: number, nick: string) => ({
  id,
  networkId: 1,
  bufferId: 9,
  target: '#chan',
  type: 'message',
  nick,
  text: `line ${id}`,
  userhost: `${nick}!~u@host`,
  time: new Date(Date.UTC(2026, 9, 25, 12, id)).toISOString(),
  self: nick === 'me',
});

// Read through alice's line; grim's came in after, then the user opened the
// channel (the divider snapshots the pointer, then it advances).
function enter() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.messages = [line(10, 'alice'), line(11, 'grima')] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.dividerAfterId = 10;
  b.lastReadId = 11;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return { buffers, w: wrapper };
}

function ignoreGrima() {
  useIgnoresStore().global = [
    {
      id: 1,
      createdAt: '',
      mask: 'grima!*@*',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['ALL'],
      isExcept: false,
      expiresAt: null,
    },
  ] as never;
}

describe('MessageList — the unread divider over hidden lines', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('stays off the user’s own line when the only line past it is hidden', async () => {
    ignoreGrima();
    const { buffers, w } = enter();
    await w.vm.$nextTick();
    expect(w.find('.unread-divider').exists()).toBe(false);
    buffers.pushMessage(line(12, 'me') as never);
    await w.vm.$nextTick();
    expect(w.find('[data-msg-id="12"]').exists()).toBe(true);
    expect(w.find('.unread-divider').exists()).toBe(false);
  });

  it('keeps a boundary that is on screen', async () => {
    const { buffers, w } = enter();
    await w.vm.$nextTick();
    expect(w.find('.unread-divider').exists()).toBe(true);
    buffers.pushMessage(line(12, 'me') as never);
    await w.vm.$nextTick();
    // Still above grima's line, not moved down to the user's.
    const html = w.html();
    expect(html.indexOf('unread-divider')).toBeLessThan(html.indexOf('data-msg-id="11"'));
  });
});
