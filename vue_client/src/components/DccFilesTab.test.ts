// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DCC tab of the files window (#1085): offers waiting, what is moving
// grouped by peer (a bot's block is its queue), and the kept files.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));
vi.mock('../stores/config.js', () => ({
  useConfigStore: () => ({ fetch: async () => 'standalone', features: { dcc: true } }),
}));

import DccFilesTab from './DccFilesTab.vue';
import { useDccStore, type DccTransfer, type DccFile } from '../stores/dcc.js';

function row(over: Partial<DccTransfer>): DccTransfer {
  return {
    id: 1,
    network_id: 1,
    peer_nick: 'Bot',
    direction: 'recv',
    filename: 'x',
    advertised_size: 0,
    received_bytes: 0,
    state: 'queued',
    crc_status: null,
    error: null,
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
    completed_at: null,
    ...over,
    // A queued pack is named for its number until the bot's offer names it.
    ...(over.pack != null && !over.filename ? { filename: `XDCC #${over.pack}` } : {}),
  };
}

const file = (id: number, name: string): DccFile => ({
  id,
  name,
  size: 2048,
  origin: 'received',
  created_at: '2026-10-16T00:00:00.000Z',
  transfer_id: null,
  peer_nick: 'Bot',
  network_id: 1,
});

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
  h.api.mockResolvedValue({});
});

function mountTab(query = '', kind: 'video' | null = null) {
  return mount(DccFilesTab, { props: { query, kind } });
}

describe('DccFilesTab', () => {
  it("shows a bot's queue as one block: the pack out, then the rest in order", async () => {
    const dcc = useDccStore();
    dcc.account = { chat: false, receive: true, send: false };
    dcc.transfers = [
      row({ id: 5, pack: 32, queue_seq: 3 }),
      row({ id: 4, pack: 31, queue_seq: 2 }),
      row({
        id: 3,
        pack: 30,
        queue_seq: 1,
        state: 'receiving',
        filename: 'ep30.mkv',
        advertised_size: 100,
        received_bytes: 41,
      }),
      row({ id: 9, peer_nick: 'carol', state: 'receiving', filename: 'talk.mp4' }),
    ];
    const w = mountTab();
    await w.vm.$nextTick();
    const blocks = w.findAll('.peer-block');
    expect(blocks).toHaveLength(2);
    const bot = blocks.find((b) => b.find('.peer-head').text().includes('Bot'))!;
    expect(bot.find('.peer-head').text()).toContain('2 queued');
    expect(bot.findAll('.name').map((n) => n.text())).toEqual(['ep30.mkv', '#31', '#32']);
    expect(bot.text()).toContain('41%');
  });

  it('removes one queued pack, or clears the queue', async () => {
    const dcc = useDccStore();
    dcc.transfers = [
      row({ id: 4, pack: 31, queue_seq: 1 }),
      row({ id: 5, pack: 32, queue_seq: 2 }),
    ];
    const w = mountTab();
    await w.vm.$nextTick();
    const remove = w
      .findAll('.row')[0]
      .findAll('.acts .link')
      .find((b) => b.text() === 'Remove')!;
    await remove.trigger('click');
    expect(h.api).toHaveBeenCalledWith('/api/dcc/4/cancel', { method: 'POST' });
    const clear = w.findAll('.peer-head .link').find((b) => b.text() === 'Clear queue')!;
    await clear.trigger('click');
    expect(h.api).toHaveBeenCalledWith('/api/dcc/xdcc/remove', {
      method: 'POST',
      body: { networkId: 1, nick: 'Bot', packs: null },
    });
  });

  it('keeps a failed pack in view with Retry, until it is queued again', async () => {
    const dcc = useDccStore();
    dcc.transfers = [row({ id: 6, pack: 29, state: 'failed', error: 'no response from Bot' })];
    const w = mountTab();
    await w.vm.$nextTick();
    expect(w.text()).toContain('failed: no response from Bot');
    expect(w.findAll('.acts .link').map((b) => b.text())).toEqual(['Retry', 'Dismiss']);
    dcc.transfers = [...dcc.transfers, row({ id: 7, pack: 29, attempt: 2 })];
    await w.vm.$nextTick();
    expect(w.text()).not.toContain('no response');
  });

  it('puts offers first, with Accept and Decline right there', async () => {
    const dcc = useDccStore();
    dcc.transfers = [
      row({ id: 8, peer_nick: 'mira', state: 'pending_approval', filename: 'a.mov' }),
    ];
    const w = mountTab();
    await w.vm.$nextTick();
    expect(w.find('.group').text()).toBe('waiting for you');
    expect(w.find('.row.inline .acts').text()).toContain('Accept');
    expect(w.find('.row.inline .acts').text()).toContain('Decline');
  });

  it('filters the kept files by search and by type, but never hides a queue', async () => {
    const dcc = useDccStore();
    dcc.filesLoaded = true;
    dcc.files = [file(1, 'ep29.mkv'), file(2, 'notes.txt')];
    dcc.transfers = [row({ id: 4, pack: 31 })];
    const w = mountTab('', 'video');
    await w.vm.$nextTick();
    expect(w.findAll('.name').map((n) => n.text())).toEqual(['#31', 'ep29.mkv']);
    await w.setProps({ query: 'notes', kind: null });
    expect(w.findAll('.name').map((n) => n.text())).toEqual(['#31', 'notes.txt']);
  });

  it('says so when DCC is not turned on for the account', async () => {
    const dcc = useDccStore();
    dcc.account = { chat: false, receive: false, send: false };
    const w = mountTab();
    await w.vm.$nextTick();
    expect(w.find('.note').text()).toContain("DCC isn't turned on for your account");
  });
});
