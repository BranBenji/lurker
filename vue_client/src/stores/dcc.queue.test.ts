// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DCC store's half of #1085: an offer's toast (Accept · Decline · Later,
// gone once the offer is answered anywhere), speed and time left from
// progress frames, and the XDCC queue's calls.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));
vi.mock('./config.js', () => ({
  useConfigStore: () => ({ fetch: async () => 'standalone', features: { dcc: true } }),
}));

import { describePacks, formatEta, retryable, useDccStore, type DccTransfer } from './dcc.js';
import { useToastsStore } from './toasts.js';

function row(over: Partial<DccTransfer>): DccTransfer {
  return {
    id: 1,
    network_id: 1,
    peer_nick: 'mira',
    direction: 'recv',
    filename: 'talk.mp4',
    advertised_size: 1000,
    received_bytes: 0,
    state: 'pending_approval',
    crc_status: null,
    error: null,
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
    completed_at: null,
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('an offer', () => {
  it('gets a toast with three answers and no ×, once', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row({}));
    dcc.applyTransfer(row({}));
    const toasts = useToastsStore();
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0]).toMatchObject({
      title: 'DCC file from mira',
      body: 'talk.mp4 · 1000 B',
      dismissible: false,
      networkId: 1,
      target: 'mira',
      actions: [
        { label: 'Accept', tone: 'good' },
        { label: 'Decline', tone: 'bad' },
        { label: 'Later', tone: 'muted' },
      ],
    });
  });

  it('accepts from the toast', async () => {
    h.api.mockResolvedValue({ transfer: row({ state: 'connecting' }) });
    const dcc = useDccStore();
    dcc.applyTransfer(row({}));
    const toasts = useToastsStore();
    toasts.runAction(toasts.items[0].id, 0);
    await vi.waitFor(() =>
      expect(h.api).toHaveBeenCalledWith('/api/dcc/1/accept', { method: 'POST' }),
    );
  });

  it('loses its toast once the offer is answered elsewhere', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row({}));
    dcc.applyTransfer(row({ state: 'rejected' }));
    expect(useToastsStore().items).toHaveLength(0);
  });

  it('stays put off after Later when the lists reload, and comes back after a sign-out', () => {
    const dcc = useDccStore();
    const toasts = useToastsStore();
    dcc.applyTransfer(row({ id: 77 }));
    toasts.clear();
    dcc.applyTransfer(row({ id: 77 }));
    expect(toasts.items).toHaveLength(1);
    toasts.runAction(toasts.items[0].id, 2);
    toasts.dismiss(toasts.items[0].id);
    dcc.applyTransfer(row({ id: 77 }));
    expect(toasts.items).toHaveLength(0);
  });

  it('gets no toast for a send of ours, or a row that is not an offer', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row({ id: 2, direction: 'send', state: 'offered' }));
    dcc.applyTransfer(row({ id: 3, state: 'queued', pack: 4 }));
    expect(useToastsStore().items).toHaveLength(0);
  });
});

describe('speed and time left', () => {
  it('comes from two progress frames, and goes when the transfer stops', () => {
    vi.useFakeTimers();
    const dcc = useDccStore();
    dcc.applyTransfer(row({ state: 'receiving', received_bytes: 0, advertised_size: 10_000 }));
    expect(dcc.rates[1]).toBeUndefined();
    vi.advanceTimersByTime(2000);
    dcc.applyTransfer(row({ state: 'receiving', received_bytes: 2000, advertised_size: 10_000 }));
    expect(dcc.rates[1].bps).toBe(1000);
    expect(dcc.rates[1].etaSeconds).toBe(8);
    dcc.applyTransfer(row({ state: 'completed', received_bytes: 10_000, advertised_size: 10_000 }));
    expect(dcc.rates[1]).toBeUndefined();
  });

  it('reads as hours, minutes, or seconds', () => {
    expect(formatEta(40)).toBe('40s');
    expect(formatEta(300)).toBe('5m');
    expect(formatEta(3840)).toBe('1h 4m');
  });
});

describe('the XDCC queue', () => {
  it('queues and applies the rows the server queued', async () => {
    h.api.mockResolvedValue({ transfers: [row({ id: 9, state: 'queued', pack: 31 })] });
    const dcc = useDccStore();
    const got = await dcc.queueXdcc(1, 'Bot', [31]);
    expect(h.api).toHaveBeenCalledWith('/api/dcc/xdcc', {
      method: 'POST',
      body: { networkId: 1, nick: 'Bot', packs: [31] },
    });
    expect(got.map((t) => t.id)).toEqual([9]);
    expect(dcc.transfers.map((t) => t.id)).toEqual([9]);
  });

  it('removes packs, or a whole bot', async () => {
    h.api.mockResolvedValue({ removed: 3 });
    expect(await useDccStore().unqueueXdcc(1, 'Bot', null)).toBe(3);
    expect(h.api).toHaveBeenCalledWith('/api/dcc/xdcc/remove', {
      method: 'POST',
      body: { networkId: 1, nick: 'Bot', packs: null },
    });
  });

  it('can retry a queued pack that ended without its file, and nothing else', () => {
    expect(retryable(row({ pack: 3, state: 'failed' }))).toBe(true);
    expect(retryable(row({ pack: 3, state: 'completed' }))).toBe(false);
    expect(retryable(row({ pack: null, state: 'failed' }))).toBe(false);
  });

  it('names packs the way the server does', () => {
    expect(describePacks([31])).toBe('#31');
    expect(describePacks([29, 30, 31, 32])).toBe('#29–#32');
    expect(describePacks([29, 31])).toBe('#29 and #31');
    expect(describePacks([29, 31, 35])).toBe('#29, #31 and #35');
  });
});
