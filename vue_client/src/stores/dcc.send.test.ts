// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Sending one of the account's files (#1086), in the store: which file a
// command names, the Files tab's pick, and a file uploaded to send.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
  upload: vi.fn<(file: Blob, opts: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));
vi.mock('../lib/chunkedUpload.js', () => ({ uploadInChunks: h.upload }));
vi.mock('./config.js', () => ({
  useConfigStore: () => ({ fetch: async () => 'standalone', features: { dcc: true } }),
}));

import { findDccFile, useDccStore, type DccFile, type DccTransfer } from './dcc.js';

function file(id: number, name: string): DccFile {
  return {
    id,
    name,
    size: 1000,
    origin: 'uploaded',
    created_at: '2026-10-15 00:00:00',
    transfer_id: null,
    peer_nick: null,
    network_id: null,
  };
}

function offered(id: number, fileId: number): DccTransfer {
  return {
    id,
    network_id: 1,
    peer_nick: 'bob',
    direction: 'send',
    filename: 'a.mkv',
    advertised_size: 1000,
    received_bytes: 0,
    state: 'offered',
    crc_status: null,
    error: null,
    created_at: '',
    updated_at: '',
    completed_at: null,
    file_id: fileId,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
  h.upload.mockReset();
});

describe('findDccFile', () => {
  const files = [file(3, 'a.mkv'), file(2, '7'), file(1, 'a.mkv')];

  it('takes the newest file of that name', () => {
    expect(findDccFile(files, 'a.mkv')?.id).toBe(3);
  });

  it('reads a name before an id, so a file called "7" is that file', () => {
    expect(findDccFile(files, '7')?.id).toBe(2);
  });

  it('takes an id as /dcc files shows it, with or without its #', () => {
    expect(findDccFile(files, '1')?.id).toBe(1);
    expect(findDccFile(files, '#3')?.id).toBe(3);
    expect(findDccFile(files, 'nope')).toBeNull();
    expect(findDccFile(files, '#99')).toBeNull();
  });
});

describe('sending from the Files tab', () => {
  it('sends the picked file to who it was picked for, and shows the transfer', async () => {
    h.api.mockResolvedValue({ transfer: offered(10, 3) });
    const dcc = useDccStore();
    dcc.openToSend({ networkId: 1, nick: 'bob', passive: true });
    expect(dcc.panelTab).toBe('files');
    expect(dcc.pick).toEqual({ networkId: 1, nick: 'bob', passive: true });
    await dcc.sendPicked(3);
    expect(h.api).toHaveBeenCalledWith('/api/dcc/send', {
      method: 'POST',
      body: { networkId: 1, nick: 'bob', fileId: 3, passive: true },
    });
    expect(dcc.pick).toBeNull();
    expect(dcc.panelTab).toBe('transfers');
    expect(dcc.transfers.map((t) => t.id)).toEqual([10]);
  });

  it('keeps the pick, and says why on the file, when the send is refused', async () => {
    const dcc = useDccStore();
    h.api.mockResolvedValue({ transfers: [], files: [] });
    dcc.openToSend({ networkId: 1, nick: 'bob', passive: false });
    h.api.mockRejectedValueOnce(new Error('network not connected'));
    await expect(dcc.sendPicked(3)).rejects.toThrow('network not connected');
    expect(dcc.pick).not.toBeNull();
    expect(dcc.fileError[3]).toBe('network not connected');
  });

  it('a plain open is not picking', () => {
    h.api.mockResolvedValue({ transfers: [], files: [] });
    const dcc = useDccStore();
    dcc.openToSend({ networkId: 1, nick: 'bob', passive: false });
    dcc.open('files');
    expect(dcc.pick).toBeNull();
  });
});

describe('uploading a file to send', () => {
  it('goes up in chunks as a DCC file, and joins the list', async () => {
    const kept = file(5, 'clip.mp4');
    h.upload.mockImplementation(async (_blob, opts) => {
      (opts.onProgress as (n: number) => void)(40);
      expect(useDccStore().uploading).toEqual({ name: 'clip.mp4', percent: 40 });
      return { file: kept };
    });
    const dcc = useDccStore();
    const got = await dcc.uploadFile(new File(['x'], 'clip.mp4'));
    expect(got).toEqual(kept);
    expect(h.upload.mock.calls[0][1]).toMatchObject({ purpose: 'dcc-send', filename: 'clip.mp4' });
    expect(dcc.files.map((f) => f.id)).toEqual([5]);
    expect(dcc.uploading).toBeNull();
  });

  it('says why it failed', async () => {
    h.upload.mockRejectedValue(new Error('over your DCC storage limit'));
    const dcc = useDccStore();
    await expect(dcc.uploadFile(new File(['x'], 'big.bin'))).rejects.toThrow(
      'over your DCC storage limit',
    );
    expect(dcc.uploadError).toBe('over your DCC storage limit');
    expect(dcc.uploading).toBeNull();
  });
});
