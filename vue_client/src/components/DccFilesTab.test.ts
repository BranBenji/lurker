// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The body of the DCC window (#1085): offers waiting, what is moving
// grouped by peer (a bot's block is its queue), and the kept files.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.js';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));
vi.mock('../stores/config.js', () => ({
  useConfigStore: () => ({ fetch: async () => 'standalone', features: { dcc: true } }),
}));

import DccFilesTab from './DccFilesTab.vue';
import { useDccStore, type DccTransfer, type DccFile } from '../stores/dcc.js';
import { useNetworksStore } from '../stores/networks.js';

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

const file = (id: number, name: string, over: Partial<DccFile> = {}): DccFile => ({
  id,
  name,
  size: 2048,
  origin: 'received',
  created_at: '2026-10-16T00:00:00.000Z',
  transfer_id: null,
  peer_nick: 'Bot',
  network_id: 1,
  crc_status: null,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
  h.api.mockResolvedValue({});
});

function mountTab(query = '', kind: 'video' | null = null) {
  return mount(DccFilesTab, { props: { query, kind } });
}

// A row's ⋮ opens the app's one context menu; its items are read off the
// composable, since ContextMenu.vue itself isn't mounted here. Closed first:
// ContextMenu.vue closes on an item's click, and ⋮ on an open menu toggles it.
async function openMore(w: VueWrapper, i = 0) {
  useContextMenu().close();
  await w.findAll('button.more')[i]!.trigger('click');
  return useContextMenu().state.items;
}
function item(items: ContextMenuItem[], label: string): ContextMenuItem {
  return items.find((it) => it.label === label)!;
}

describe('DccFilesTab', () => {
  afterEach(() => useContextMenu().close());

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
      .findAll('.acts button')
      .find((b) => b.text() === 'Remove')!;
    await remove.trigger('click');
    expect(h.api).toHaveBeenCalledWith('/api/dcc/4/cancel', { method: 'POST' });
    const clear = w.findAll('.peer-head button').find((b) => b.text() === 'Clear queue')!;
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
    const items = await openMore(w);
    expect(items.map((i) => i.label)).toEqual(['Retry', 'Dismiss']);
    expect(items.every((i) => i.icon)).toBe(true);
    dcc.transfers = [...dcc.transfers, row({ id: 7, pack: 29, attempt: 2 })];
    await w.vm.$nextTick();
    expect(w.text()).not.toContain('no response');
  });

  it('hides a failed try once a later one exists, even a finished one', async () => {
    const dcc = useDccStore();
    dcc.transfers = [
      row({ id: 7, pack: 29, state: 'completed', filename: 'ep29.mkv', attempt: 2 }),
      row({ id: 6, pack: 29, state: 'failed', error: 'no response from Bot' }),
    ];
    const w = mountTab();
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

  it('answers an offer from its row', async () => {
    const dcc = useDccStore();
    const accept = vi.spyOn(dcc, 'accept').mockResolvedValue(row({}));
    const reject = vi.spyOn(dcc, 'reject').mockResolvedValue(row({}));
    dcc.transfers = [
      row({ id: 8, peer_nick: 'mira', state: 'pending_approval', filename: 'a.mov' }),
    ];
    const w = mountTab();
    await w.vm.$nextTick();
    const [yes, no] = w.findAll('.row.inline .acts button');
    await yes.trigger('click');
    await no.trigger('click');
    expect(accept).toHaveBeenCalledWith(8);
    expect(reject).toHaveBeenCalledWith(8);
  });

  it('says where each transfer is, and offers what fits it', async () => {
    const dcc = useDccStore();
    useNetworksStore().networks = [{ id: 1, name: 'rizon' }] as never;
    dcc.transfers = [
      row({ id: 1, pack: 1, state: 'requested', filename: 'XDCC #1' }),
      row({
        id: 2,
        pack: 2,
        peer_nick: 'Two',
        state: 'requested',
        filename: 'XDCC #2',
        bot_acked_at: '2026-10-16T00:00:00.000Z',
      }),
      row({ id: 3, pack: 3, peer_nick: 'Three', state: 'connecting', filename: 'c.mkv' }),
      row({ id: 4, peer_nick: 'four', state: 'verifying', filename: 'v.mkv' }),
      row({ id: 5, peer_nick: 'five', direction: 'send', state: 'offered', filename: 'o.txt' }),
      row({
        id: 6,
        peer_nick: 'six',
        direction: 'send',
        state: 'sending',
        filename: 's.txt',
        advertised_size: 100,
        received_bytes: 50,
      }),
      row({
        id: 7,
        peer_nick: 'seven',
        state: 'failed',
        filename: 'p.mkv',
        advertised_size: 100,
        received_bytes: 30,
        destination_path: '/x/p.mkv',
      }),
    ];
    const w = mountTab();
    await w.vm.$nextTick();
    const text = w.text();
    expect(text).toContain('asked, waiting for an answer');
    expect(text).toContain("in the bot's queue");
    expect(text).toContain('#3 | connecting');
    expect(text).toContain('checking the checksum');
    expect(text).toContain('offered to five, waiting for them to accept');
    expect(text).toContain('to six');
    expect(text).toContain('50% | 50 B of 100 B');
    expect(text).toContain('failed at 30% | it resumes if seven sends it again');
    const labels: string[] = [];
    for (let i = 0; i < w.findAll('button.more').length; i++) {
      labels.push(...(await openMore(w, i)).map((it) => it.label!));
    }
    expect(labels).toEqual(expect.arrayContaining(['Cancel', 'Withdraw', 'Delete partial']));
  });

  it('deletes a partial only once confirmed', async () => {
    const dcc = useDccStore();
    const clear = vi.spyOn(dcc, 'clearTransfer').mockResolvedValue();
    const confirm = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    dcc.transfers = [
      row({
        id: 7,
        state: 'failed',
        filename: 'p.mkv',
        received_bytes: 30,
        destination_path: '/x/p.mkv',
      }),
    ];
    const w = mountTab();
    await w.vm.$nextTick();
    const del = item(await openMore(w), 'Delete partial');
    del.onClick!();
    expect(clear).not.toHaveBeenCalled();
    del.onClick!();
    expect(clear).toHaveBeenCalledWith(7, true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('shows speed and time left while a transfer moves', async () => {
    const dcc = useDccStore();
    dcc.transfers = [
      row({
        id: 3,
        state: 'receiving',
        filename: 'r.mkv',
        advertised_size: 100,
        received_bytes: 41,
      }),
    ];
    dcc.rates = { 3: { bps: 2048, etaSeconds: 300 } } as never;
    const w = mountTab();
    await w.vm.$nextTick();
    expect(w.text()).toContain('41% | 2.0 KB/s | 5m left');
  });

  it("opens one row's ⋮ menu at a time, and closes it again", async () => {
    const dcc = useDccStore();
    dcc.filesLoaded = true;
    dcc.files = [file(1, 'a.mkv'), file(2, 'b.mkv')];
    const w = mountTab();
    await w.vm.$nextTick();
    const menu = useContextMenu();
    const [one, two] = w.findAll('button.more');
    await one.trigger('click');
    expect(menu.state.open).toBe(true);
    expect(one.attributes('aria-expanded')).toBe('true');
    await two.trigger('click');
    expect(menu.state.open).toBe(true);
    expect(menu.state.triggerEl).toBe(two.element);
    expect(one.attributes('aria-expanded')).toBe('false');
    expect(two.attributes('aria-expanded')).toBe('true');
    // The same ⋮ again closes it; so does anything else that closes the menu.
    await two.trigger('click');
    expect(menu.state.open).toBe(false);
    expect(two.attributes('aria-expanded')).toBe('false');
    await one.trigger('click');
    menu.close();
    await w.vm.$nextTick();
    expect(one.attributes('aria-expanded')).toBe('false');
  });

  it('counts partials and what is on the way, as the limit does (#1153)', async () => {
    const dcc = useDccStore();
    dcc.filesLoaded = true;
    dcc.account = { chat: false, receive: true, send: false, limitBytes: 10 * 1024 } as never;
    dcc.files = [file(1, 'kept.mkv')];
    dcc.transfers = [
      // A failed transfer's partial, and one still coming in, both count to the total.
      row({ id: 5, state: 'failed', destination_path: '/d/a.mkv', received_bytes: 1024 }),
      row({
        id: 6,
        state: 'receiving',
        destination_path: '/d/b.mkv',
        received_bytes: 1024,
        advertised_size: 4096,
      }),
      // A finished one's bytes are its kept file's, already counted.
      row({ id: 7, state: 'completed', destination_path: '/d/kept.mkv', file_id: 1 }),
    ];
    const w = mountTab();
    await w.vm.$nextTick();
    // Only the failed one is a partial Delete partial can free; the rest of
    // the one coming in is on the way, which the limit holds back too.
    expect(w.findAll('.group').at(-1)!.text()).toBe(
      'kept4.0 KB of 10.0 KB | 1.0 KB in partials | 3.0 KB on the way',
    );

    // With no kept files, partials alone still show.
    dcc.files = [];
    dcc.transfers = [
      row({ id: 5, state: 'failed', destination_path: '/d/a.mkv', received_bytes: 1024 }),
    ];
    await w.vm.$nextTick();
    expect(w.findAll('.group').at(-1)!.text()).toBe('kept1.0 KB of 10.0 KB | 1.0 KB in partials');
  });

  it('says how a received file checked out when there was a checksum, and nothing for an upload (#1082)', async () => {
    const dcc = useDccStore();
    dcc.filesLoaded = true;
    dcc.files = [
      file(1, 'ok.mkv', { crc_status: 'ok' }),
      file(2, 'bad.mkv', { crc_status: 'mismatch' }),
      file(3, 'plain.mkv', { crc_status: 'absent' }),
      file(4, 'resumed.mkv', { crc_status: 'unverified' }),
      file(5, 'mine.mkv', { origin: 'uploaded', peer_nick: null, network_id: null }),
    ];
    const w = mountTab();
    await w.vm.$nextTick();
    const rows = w.findAll('.list .row');
    const note = (i: number) => rows[i]!.find('.crc');
    expect(note(0).text()).toBe('Verified');
    expect(note(0).classes()).toContain('good');
    expect(note(1).text()).toBe('Checksum mismatch');
    expect(note(1).classes()).toContain('bad');
    expect(rows[1]!.find('.glyph').classes()).toContain('bad');
    // No checksum in the name, or a resume that couldn't be read back: nothing to say.
    expect(note(2).exists()).toBe(false);
    expect(rows[2]!.find('.sub').text()).not.toMatch(/verified/i);
    expect(note(3).exists()).toBe(false);
    expect(note(4).exists()).toBe(false);
    expect(rows[0]!.find('.sub').text()).toMatch(/^net:1\/Bot \| .* \| Verified$/);
  });

  it('downloads a kept file, and deletes it only once confirmed', async () => {
    const dcc = useDccStore();
    dcc.filesLoaded = true;
    dcc.files = [file(1, 'a.mkv')];
    const download = vi.spyOn(dcc, 'downloadKeptFile').mockResolvedValue();
    const del = vi.spyOn(dcc, 'deleteKeptFile').mockResolvedValue();
    vi.stubGlobal(
      'confirm',
      vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValueOnce(true),
    );
    const w = mountTab();
    await w.vm.$nextTick();
    const run = async (label: string) => item(await openMore(w), label).onClick!();
    await run('Download');
    expect(download).toHaveBeenCalledWith(1);
    await run('Delete');
    expect(del).not.toHaveBeenCalled();
    await run('Delete');
    expect(del).toHaveBeenCalledWith(1);
  });

  it('while picking, sends the file picked, or one uploaded for the pick', async () => {
    const dcc = useDccStore();
    dcc.filesLoaded = true;
    dcc.files = [file(1, 'a.mkv')];
    dcc.pick = { networkId: 1, nick: 'bob', passive: false };
    const picked = vi.spyOn(dcc, 'sendPicked').mockResolvedValue(null);
    const upload = vi.spyOn(dcc, 'uploadFile').mockResolvedValue(file(9, 'new.txt'));
    const w = mountTab();
    await w.vm.$nextTick();
    expect(w.find('.pick').text()).toContain('Pick a file to send to bob');
    await w
      .findAll('.acts button')
      .find((b) => b.text() === 'Send')!
      .trigger('click');
    expect(picked).toHaveBeenCalledWith(1);

    const input = w.find('input[type="file"]');
    const click = vi.spyOn(input.element as HTMLInputElement, 'click');
    await w.find('.pick .link.inline').trigger('click');
    expect(click).toHaveBeenCalled();
    const chosen = new File(['hi'], 'new.txt');
    Object.defineProperty(input.element, 'files', { value: [chosen], configurable: true });
    await input.trigger('change');
    await vi.waitFor(() => expect(picked).toHaveBeenLastCalledWith(9));
    expect(upload).toHaveBeenCalledWith(chosen);

    await w.find('.pick .btn-bar button').trigger('click');
    expect(dcc.pick).toBeNull();
  });
});
