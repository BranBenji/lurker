// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Compact layout: a message that opens an author run carries its time on the
// head line beside the nick, always; continuation rows carry none.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

function message(id: number, nick: string, minute: number, second = 0) {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick,
    text: `line ${id}`,
    time: new Date(Date.UTC(2026, 9, 5, 12, minute, second)).toISOString(),
  };
}

function mountCompact() {
  useSettingsStore().values = {
    'look.message.layout': 'compact',
    'look.message.collapse_timestamps': true,
  } as never;
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = useBuffersStore().ensure(1, '#chan', 9);
  b.members = [];
  b.messages = [
    message(1, 'alice', 0),
    message(2, 'alice', 0, 30),
    message(3, 'alice', 2),
    message(4, 'bob', 2, 10),
  ] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
}

function row(id: number) {
  const el = wrapper!.find(`[data-msg-id="${id}"]`).element;
  return {
    headTime: el.querySelector(':scope > .head .time')?.textContent ?? null,
    bodyTime: el.querySelector(':scope > .time')?.textContent ?? null,
  };
}

describe('MessageList — compact head timestamp', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('puts the time on the head line of a run and nowhere else on that row', () => {
    mountCompact();
    expect(row(1).headTime).toBeTruthy();
    expect(row(1).bodyTime).toBeNull();
  });

  it('shows no time on continuation rows, even when the minute changes', () => {
    mountCompact();
    expect(row(2)).toEqual({ headTime: null, bodyTime: null });
    expect(row(3)).toEqual({ headTime: null, bodyTime: null });
  });

  it('ignores timestamp collapsing: a head in the same minute still shows its time', () => {
    mountCompact();
    // bob's 12:02 matches alice's line above, which collapsing would blank.
    expect(row(4).headTime).toBeTruthy();
  });
});
