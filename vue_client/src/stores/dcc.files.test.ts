// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The files the account keeps (#1133), in the store: the list, live frames,
// and the Files tab's actions.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));
// Whether the instance runs DCC, as /api/config said.
const features = vi.hoisted(() => ({ dcc: true }));
vi.mock('./config.js', () => ({
  useConfigStore: () => ({ fetch: async () => 'standalone', features }),
}));

import { holdsPartial, keptFileUrl, useDccStore, type DccFile, type DccTransfer } from './dcc.js';

function file(id: number, over: Partial<DccFile> = {}): DccFile {
  return {
    id,
    name: `f${id}.mkv`,
    size: 1000,
    origin: 'received',
    created_at: '2026-10-14 00:00:00',
    transfer_id: id * 10,
    peer_nick: 'bot',
    network_id: 1,
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
});

describe('dcc store files', () => {
  it('loads newest first, and keeps them in that order as frames arrive', async () => {
    const dcc = useDccStore();
    h.api.mockResolvedValueOnce({ files: [file(1), file(3)] });
    await dcc.loadFiles();
    expect(h.api).toHaveBeenCalledWith('/api/dcc/files');
    dcc.applyFile(file(2));
    dcc.applyFile(file(4));
    expect(dcc.files.map((f) => f.id)).toEqual([4, 3, 2, 1]);
    dcc.dropFile(3);
    expect(dcc.files.map((f) => f.id)).toEqual([4, 2, 1]);
  });

  it('shows the panel button for files alone', () => {
    const dcc = useDccStore();
    expect(dcc.hasAny).toBe(false);
    dcc.applyFile(file(1));
    expect(dcc.hasAny).toBe(true);
  });

  it('deletes a file, and drops it only once the server has', async () => {
    const dcc = useDccStore();
    dcc.applyFile(file(5));
    h.api.mockRejectedValueOnce(new Error('cancel the transfer first'));
    await expect(dcc.deleteKeptFile(5)).rejects.toThrow('cancel the transfer first');
    expect(dcc.files).toHaveLength(1);
    expect(dcc.fileError[5]).toBe('cancel the transfer first');
    h.api.mockResolvedValueOnce({ ok: true });
    await dcc.deleteKeptFile(5);
    expect(h.api).toHaveBeenLastCalledWith('/api/dcc/files/5', { method: 'DELETE' });
    expect(dcc.files).toHaveLength(0);
  });

  it('says why a download was refused instead of saving the error', async () => {
    const dcc = useDccStore();
    dcc.applyFile(file(6));
    h.api.mockRejectedValueOnce(Object.assign(new Error(''), { status: 410 }));
    await expect(dcc.downloadKeptFile(6)).rejects.toThrow('file is no longer on the server');
    expect(h.api).toHaveBeenCalledWith(keptFileUrl(6), { method: 'HEAD' });
    expect(dcc.fileError[6]).toBe('file is no longer on the server');
  });

  it('opens the DCC window, loading both DCC lists', () => {
    const dcc = useDccStore();
    h.api.mockResolvedValue({ transfers: [], files: [] });
    dcc.open();
    expect(dcc.panelOpen).toBe(true);
    expect(h.api).toHaveBeenCalledWith('/api/dcc');
    expect(h.api).toHaveBeenCalledWith('/api/dcc/files');
  });

  it('loads nothing of DCC where DCC is off', () => {
    features.dcc = false;
    try {
      const dcc = useDccStore();
      dcc.open();
      expect(dcc.panelOpen).toBe(true);
      expect(h.api).not.toHaveBeenCalled();
    } finally {
      features.dcc = true;
    }
  });
});

describe('dcc store files, while the list loads', () => {
  // The response was read before these frames went out.
  it('keeps a file kept, and a file deleted, while the list was on its way', async () => {
    const dcc = useDccStore();
    let answer!: (v: unknown) => void;
    h.api.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const loading = dcc.loadFiles();
    dcc.applyFile(file(9)); // received meanwhile
    dcc.dropFile(2); // deleted from another tab meanwhile
    answer({ files: [file(1), file(2)] });
    await loading;
    expect(dcc.files.map((f) => f.id)).toEqual([9, 1]);
  });

  // So the panel's button is there from the start whenever there is anything
  // in it, as friends and favorites are.
  it('loads both lists with every snapshot, on an instance that runs DCC', async () => {
    const dcc = useDccStore();
    h.api.mockImplementation(async (url) =>
      url === '/api/dcc/files' ? { files: [file(1)] } : { transfers: [] },
    );
    await dcc.resync();
    expect(h.api).toHaveBeenCalledWith('/api/dcc');
    expect(h.api).toHaveBeenCalledWith('/api/dcc/files');
    await vi.waitFor(() => expect(dcc.hasAny).toBe(true));
  });

  it('asks nothing of an instance without DCC', async () => {
    features.dcc = false;
    try {
      await useDccStore().resync();
      expect(h.api).not.toHaveBeenCalled();
    } finally {
      features.dcc = true;
    }
  });
});

describe('dcc store transfers, while the list loads', () => {
  it('keeps a completion that landed while a refetch was on its way', async () => {
    const dcc = useDccStore();
    const t = (state: string) =>
      ({
        id: 4,
        network_id: 1,
        peer_nick: 'bot',
        filename: 'a.mkv',
        advertised_size: 10,
        received_bytes: 10,
        state,
        crc_status: null,
        error: null,
        created_at: '',
        updated_at: '',
        completed_at: null,
      }) as unknown as Parameters<typeof dcc.applyTransfer>[0];
    let answer!: (v: unknown) => void;
    h.api.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const loading = dcc.load();
    dcc.applyTransfer(t('completed'));
    answer({ transfers: [t('receiving')] });
    await loading;
    expect(dcc.transfers.map((x) => x.state)).toEqual(['completed']);
  });
});

describe('dcc store, clearing transfers (#1133)', () => {
  const t = (id: number, state = 'completed') =>
    ({
      id,
      network_id: 1,
      peer_nick: 'bot',
      filename: `t${id}.mkv`,
      advertised_size: 10,
      received_bytes: 10,
      state,
      crc_status: null,
      error: null,
      created_at: '',
      updated_at: '',
      completed_at: null,
    }) as unknown as DccTransfer;

  it('clears one, and drops it only once the server has', async () => {
    const dcc = useDccStore();
    dcc.applyTransfer(t(1));
    h.api.mockRejectedValueOnce(new Error('cancel the transfer before clearing it'));
    await expect(dcc.clearTransfer(1)).rejects.toThrow('cancel the transfer before clearing it');
    expect(dcc.transfers).toHaveLength(1);
    expect(dcc.actionError[1]).toBe('cancel the transfer before clearing it');
    h.api.mockResolvedValueOnce({ ids: [1] });
    await dcc.clearTransfer(1);
    expect(h.api).toHaveBeenLastCalledWith('/api/dcc/1', { method: 'DELETE' });
    expect(dcc.transfers).toHaveLength(0);
    expect(dcc.actionError[1]).toBeUndefined();
  });

  it('clears what the server cleared, and leaves the rest', async () => {
    const dcc = useDccStore();
    for (const id of [1, 2, 3]) dcc.applyTransfer(t(id, id === 2 ? 'receiving' : 'completed'));
    h.api.mockResolvedValueOnce({ ids: [1, 3] });
    expect(await dcc.clearFinished()).toBe(2);
    expect(h.api).toHaveBeenCalledWith('/api/dcc/clear', { method: 'POST' });
    expect(dcc.transfers.map((x) => x.id)).toEqual([2]);
    expect(dcc.clearing).toBe(false);
  });

  it('shows a failed clear apart from the list, leaving a load error alone', async () => {
    const dcc = useDccStore();
    dcc.listError = 'failed to load transfers';
    h.api.mockRejectedValueOnce(new Error('server unreachable'));
    await expect(dcc.clearFinished()).rejects.toThrow('server unreachable');
    expect(dcc.clearError).toBe('server unreachable');
    expect(dcc.listError).toBe('failed to load transfers');
  });

  it('tells a partial download from a kept file', () => {
    const partial = { ...t(1, 'failed'), destination_path: '/p' };
    const kept = { ...t(2), destination_path: '/k', file_id: 9 };
    expect(holdsPartial(partial)).toBe(true);
    expect(holdsPartial(kept)).toBe(false);
    expect(holdsPartial(t(3, 'rejected'))).toBe(false);
    // A path with nothing received is a reservation, not a partial.
    expect(holdsPartial({ ...t(5, 'failed'), destination_path: '/e', received_bytes: 0 })).toBe(
      false,
    );
    expect(holdsPartial({ ...t(4, 'receiving'), destination_path: '/r' })).toBe(false);
  });

  it('never brings a cleared transfer back on a late action response', async () => {
    const dcc = useDccStore();
    dcc.applyTransfer(t(6, 'receiving'));
    let answer!: (v: unknown) => void;
    h.api.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const cancelling = dcc.cancel(6);
    dcc.applyTransfer(t(6, 'cancelled'));
    dcc.dropTransfers([6]); // another tab cleared it
    answer({ transfer: t(6, 'cancelled') });
    await cancelling;
    expect(dcc.transfers).toEqual([]);
  });

  it('asks the server to delete a partial only when told to', async () => {
    const dcc = useDccStore();
    h.api.mockResolvedValue({ ids: [7] });
    await dcc.clearTransfer(7, true);
    expect(h.api).toHaveBeenLastCalledWith('/api/dcc/7?partial=delete', { method: 'DELETE' });
  });

  it('keeps a clear that landed while the list was on its way', async () => {
    const dcc = useDccStore();
    let answer!: (v: unknown) => void;
    h.api.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const loading = dcc.load();
    dcc.dropTransfers([4]); // cleared from another tab meanwhile
    answer({ transfers: [t(5), t(4)] });
    await loading;
    expect(dcc.transfers.map((x) => x.id)).toEqual([5]);
  });
});
