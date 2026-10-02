// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// /away and /back through the real composer (#994): they name the network
// they're typed on, and carry -all/-one as `all` for the server to scope.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { socketSend } from '../composables/useSocket.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let mounted: VueWrapper[] = [];

function seed() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 7, name: 'testnet' }] as never;
  networks.states = { 7: { nick: 'me' } } as never;
  buffers.buffers['7::#chan'] = {
    networkId: 7,
    target: '#chan',
    members: [],
    messages: [],
  } as never;
  networks.activeKey = '7::#chan';
  useRecentBuffersStore().keys = ['7::#chan'];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function run(command: string) {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  const el = wrapper.find('textarea').element as HTMLTextAreaElement;
  el.value = command;
  el.setSelectionRange(command.length, command.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
}

const sent = () =>
  vi
    .mocked(socketSend)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((p) => p.type === 'away' || p.type === 'back');

describe('/away and /back', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    seed();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('name the network they’re typed on, and leave the scope to the setting', async () => {
    await run('/away lunch');
    await run('/back');
    expect(sent()).toEqual([
      { type: 'away', message: 'lunch', networkId: 7 },
      { type: 'back', networkId: 7 },
    ]);
  });

  it('carry -all and -one', async () => {
    await run('/away -all lunch');
    await run('/away -one');
    await run('/back -all');
    expect(sent()).toEqual([
      { type: 'away', message: 'lunch', networkId: 7, all: true },
      { type: 'away', message: '', networkId: 7, all: false },
      { type: 'back', networkId: 7, all: true },
    ]);
  });
});
