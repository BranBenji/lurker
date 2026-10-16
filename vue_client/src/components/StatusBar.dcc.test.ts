// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The status bar's DCC segment (#1085): in a DM, what is in flight with that
// nick over DCC, on one line. A phone keeps the numbers and drops the name.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../api.js', () => ({ api: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})) }));

import StatusBar from './StatusBar.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useDccStore, type DccTransfer } from '../stores/dcc.js';

function row(over: Partial<DccTransfer>): DccTransfer {
  return {
    id: 1,
    network_id: 1,
    peer_nick: 'Bot',
    direction: 'recv',
    filename: 'ep30.mkv',
    advertised_size: 100,
    received_bytes: 41,
    state: 'receiving',
    crc_status: null,
    error: null,
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
    completed_at: null,
    ...over,
  };
}

function mountOn(target: string, compact = false) {
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'rizon' }] as never;
  networks.states[1] = { networkId: 1, channels: [], state: 'connected' } as never;
  networks.activeKey = `1::${target}`;
  // The DM, as it is when you're in it: findDm resolves a nick through it.
  useBuffersStore().ensure(1, target);
  return mount(StatusBar, {
    props: { compact },
    global: { stubs: { SuggestionStrip: true, MircColorPicker: true, UploadMenu: true } },
  });
}

const seg = (w: ReturnType<typeof mountOn>) => w.find('.seg.dcc');

describe('StatusBar — DCC segment', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("shows the bot's pack moving, and how many wait", () => {
    useDccStore().transfers = [
      row({ id: 1, pack: 30 }),
      row({ id: 2, pack: 31, state: 'queued', filename: 'XDCC #31' }),
      row({ id: 3, pack: 32, state: 'queued', filename: 'XDCC #32' }),
    ];
    expect(seg(mountOn('bot')).text()).toBe('ep30.mkv 41% · 2 queued');
  });

  it('keeps the numbers and drops the name on a phone', () => {
    useDccStore().transfers = [row({})];
    expect(seg(mountOn('Bot', true)).text()).toBe('41%');
  });

  it('says when the bot has us in its own queue', () => {
    useDccStore().transfers = [
      row({
        pack: 31,
        state: 'requested',
        filename: 'XDCC #31',
        bot_acked_at: '2026-10-16T00:00:00Z',
      }),
    ];
    const s = seg(mountOn('Bot'));
    expect(s.text()).toBe("#31 in the bot's queue");
    expect(s.classes()).toContain('warn');
  });

  it('opens the DCC window when tapped', async () => {
    useDccStore().transfers = [row({})];
    const w = mountOn('Bot');
    await seg(w).trigger('click');
    expect(useDccStore().panelOpen).toBe(true);
  });

  it('is not in a channel, another DM, or for an offer still waiting', () => {
    useDccStore().transfers = [
      row({}),
      row({ id: 2, peer_nick: 'mira', state: 'pending_approval' }),
    ];
    expect(seg(mountOn('#rizon')).exists()).toBe(false);
    expect(seg(mountOn('carol')).exists()).toBe(false);
    expect(seg(mountOn('mira')).exists()).toBe(false);
  });
});
