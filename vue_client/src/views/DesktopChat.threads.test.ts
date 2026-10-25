// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The desktop shell around the thread panel (#1225): opening a thread route
// mounts the panel beside the list, and closing it brings the shell back whole
// — message list and member list included.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import DesktopChat from './DesktopChat.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';

vi.mock('../composables/useSocket.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../composables/useSocket.js')>();
  return {
    ...actual,
    useSocket: vi.fn<() => void>(),
    socketSend: vi.fn<() => boolean>(() => true),
    socketSendWithAck: vi.fn<() => null>(() => null),
    onSocketOpen: vi.fn<() => () => void>(() => () => {}),
  };
});
vi.mock('../composables/useChatBootstrap.js', () => ({
  useChatBootstrap: vi.fn<() => void>(),
  consumeColdStartJump: vi.fn<() => null>(() => null),
}));

let wrapper: VueWrapper | null = null;
let router: Router;

function seed() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', canReply: true } } as never;
  networks.loaded = true as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.joined = true;
  b.members = [{ nick: 'alice', modes: [], away: false }];
  b.messages = [
    {
      id: 1,
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      type: 'message',
      nick: 'alice',
      text: 'hello',
      msgid: 'm1',
      time: new Date().toISOString(),
    },
  ] as never;
  networks.activeKey = '1::#chan';
  useSettingsStore().values['chat.threads'] = true;
}

async function mountAt(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'chat', component: DesktopChat },
      { path: '/system', name: 'system', component: DesktopChat },
      { path: '/buffer/:id', name: 'buffer', component: DesktopChat },
      { path: '/buffer/:id/members', name: 'buffer-members', component: DesktopChat },
      { path: '/buffer/:id/thread/:root', name: 'buffer-thread', component: DesktopChat },
      { path: '/buffer/:id/threads', name: 'buffer-threads', component: DesktopChat },
    ],
  });
  await router.push(path);
  wrapper = mount(DesktopChat, { attachTo: document.body, global: { plugins: [router] } });
  await wrapper.vm.$nextTick();
  return wrapper;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('DesktopChat — thread panel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seed();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('shows the panel on a thread route and the whole shell again when it closes', async () => {
    const w = await mountAt('/buffer/9');
    expect(w.find('.message-list').exists()).toBe(true);
    expect(w.find('.members').exists()).toBe(true);
    expect(w.find('.thread-panel').exists()).toBe(false);

    await router.push('/buffer/9/thread/m1');
    await settle();
    await w.vm.$nextTick();
    expect(w.find('.thread-panel').exists()).toBe(true);
    expect(w.find('.chat').classes()).toContain('thread-open');
    expect(w.find('.message-list').exists()).toBe(true);
    // The member list yields the room while the panel is up.
    expect(w.find('.members').exists()).toBe(false);

    await w.find('.thread-panel .close').trigger('click');
    await settle();
    await w.vm.$nextTick();
    expect(router.currentRoute.value.fullPath).toBe('/buffer/9');
    expect(w.find('.thread-panel').exists()).toBe(false);
    expect(w.find('.chat').classes()).not.toContain('thread-open');
    expect(w.find('.message-list').exists()).toBe(true);
    expect(w.find('.message-list [data-msg-id="1"]').exists()).toBe(true);
    expect(w.find('.members').exists()).toBe(true);
  });
});
