// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The smart event tier through the real MessageList, for the one event whose
// actor has two names: a rename. The store carries the speaker entry to the new
// nick as the event lands, and own-nick can land before the row renders, so
// both names have to be asked.

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
let nextId = 1;
const at = (minute: number) => Date.UTC(2026, 9, 4, 12, minute);

function row(type: string, nick: string, minute: number, extra: Record<string, unknown> = {}) {
  return {
    id: nextId++,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type,
    nick,
    text: type === 'message' ? 'hello' : '',
    userhost: `${nick}!~u@host`,
    time: new Date(at(minute)).toISOString(),
    self: false,
    ...extra,
  };
}

function mountWith(messages: Record<string, unknown>[], ownNick = 'me') {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: ownNick, state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.messages = messages as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return wrapper;
}

const shown = (w: VueWrapper, id: number) => w.find(`[data-msg-id="${id}"]`).exists();

describe('MessageList — smart filter and renames', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
    useSettingsStore().values = { 'chat.events': 'smart', 'chat.events.mobile': 'smart' } as never;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('shows the rename of somebody who just spoke', () => {
    const buffers = useBuffersStore();
    const said = row('message', 'alice', 0);
    const renamed = row('nick', 'alice', 1, { newNick: 'alice_afk' });
    buffers.recordSpeaker(1, '#chan', 'alice', at(0));
    // What useSocket does as the nick event lands: the speaker entry moves to the new name.
    buffers.renameMember(1, '#chan', 'alice', 'alice_afk');
    const w = mountWith([said, renamed]);
    expect(shown(w, said.id)).toBe(true);
    expect(shown(w, renamed.id)).toBe(true);
  });

  it('still hides the rename of somebody who never spoke', () => {
    const buffers = useBuffersStore();
    const said = row('message', 'alice', 0);
    const renamed = row('nick', 'bob', 1, { newNick: 'bob_afk' });
    buffers.recordSpeaker(1, '#chan', 'alice', at(0));
    buffers.renameMember(1, '#chan', 'bob', 'bob_afk');
    const w = mountWith([said, renamed]);
    expect(shown(w, renamed.id)).toBe(false);
  });

  it('shows our own rename after own-nick has already moved us', () => {
    // A nick row carries no self flag, and own-nick landing first leaves the row's OLD name
    // failing the own-nick comparison.
    const renamed = row('nick', 'me', 1, { newNick: 'me_away' });
    const w = mountWith([renamed], 'me_away');
    expect(shown(w, renamed.id)).toBe(true);
  });
});
