// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));

import { hasFile, useDccStore, type DccTransfer, type DccState } from './dcc.js';

function row(state: DccState, over: Partial<DccTransfer> = {}): DccTransfer {
  return {
    id: 7,
    network_id: 1,
    peer_nick: 'bot',
    filename: 'f.bin',
    advertised_size: 1000,
    received_bytes: 0,
    state,
    crc_status: null,
    error: null,
    created_at: '2026-10-13 00:00:00',
    updated_at: '2026-10-13 00:00:00',
    completed_at: null,
    ...over,
  };
}

// #1125: Delete shows wherever a finished transfer left a file on the server.
describe('hasFile', () => {
  const at = { destination_path: '/srv/dcc/a/f.bin' };

  it('is true for a finished row that still owns a file', () => {
    expect(hasFile(row('completed', at))).toBe(true);
    expect(hasFile(row('failed', at))).toBe(true);
    expect(hasFile(row('cancelled', at))).toBe(true);
  });

  // Deleted, never written, or taken over by a newer transfer (a resume): the
  // server cleared the path, so there is nothing for this row to offer.
  it('is false in flight, or once the row no longer owns a file', () => {
    expect(hasFile(row('receiving', at))).toBe(false);
    expect(hasFile(row('stalled', at))).toBe(false);
    expect(hasFile(row('rejected'))).toBe(false);
    expect(hasFile(row('completed', { destination_path: null }))).toBe(false);
  });
});

describe('dcc store deleteFile', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.api.mockReset();
  });

  it('DELETEs the file and applies the row it gets back', async () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row('completed', { destination_path: '/srv/dcc/a/f.bin' }));
    h.api.mockResolvedValue({
      transfer: row('completed', { destination_path: null, file_deleted_at: '2026-10-13 01:00' }),
    });
    await dcc.deleteFile(7);
    expect(h.api).toHaveBeenCalledWith('/api/dcc/7/file', { method: 'DELETE' });
    expect(dcc.transfers[0].file_deleted_at).toBeTruthy();
    expect(hasFile(dcc.transfers[0])).toBe(false);
  });

  it('shows a refusal on the row', async () => {
    h.api.mockRejectedValue(new Error('cancel the transfer before deleting its file'));
    const dcc = useDccStore();
    await expect(dcc.deleteFile(7)).rejects.toThrow('cancel the transfer');
    expect(dcc.actionError[7]).toBe('cancel the transfer before deleting its file');
    expect(dcc.busy[7]).toBeUndefined();
  });
});
