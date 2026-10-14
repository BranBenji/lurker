// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The web client's side of an upload session (#650): chunks at the server's
// offset, carrying on from wherever the server got to after a failure.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Opts = { method?: string; body?: unknown };
type SendOpts = {
  headers?: Record<string, string>;
  onProgress?: (loaded: number, total: number) => void;
};
const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: Opts) => Promise<unknown>>(),
  apiSend: vi.fn<(method: string, url: string, body: Blob, opts?: SendOpts) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api, apiSend: h.apiSend }));

import { uploadInChunks } from './chunkedUpload.js';

const SESSION = '/api/upload-sessions/s1';
const file = new Blob(['0123456789abcdefghij']); // 20 bytes, chunks of 8

// A server holding `held` bytes. A chunk is taken only at its offset; `drop`
// makes the next n chunks fail as a lost connection would, after `keep` of
// their bytes arrived.
function server({ drop = 0, keep = 0 } = {}) {
  const state = { held: 0, drop, sent: [] as string[], completed: false, deleted: false };
  h.api.mockImplementation(async (url, opts) => {
    if (url === '/api/upload-sessions') return { id: 's1', offset: 0, chunkBytes: 8 };
    if (url === SESSION && opts?.method === 'DELETE') {
      state.deleted = true;
      return { ok: true };
    }
    if (url === SESSION) return { offset: state.held };
    if (url === `${SESSION}/complete`) {
      state.completed = true;
      return { url: 'https://x/done', body: opts?.body };
    }
    throw new Error(`unexpected ${url}`);
  });
  h.apiSend.mockImplementation(async (_m, _url, body, opts) => {
    const offset = Number(opts!.headers!['Upload-Offset']);
    const text = await body.text();
    if (offset !== state.held) throw Object.assign(new Error('offset'), { status: 409 });
    if (state.drop > 0) {
      state.drop--;
      state.held += keep;
      throw new Error('network error');
    }
    opts?.onProgress?.(text.length, text.length);
    state.sent.push(text);
    state.held += text.length;
    return { offset: state.held };
  });
  return state;
}

beforeEach(() => {
  h.api.mockReset();
  h.apiSend.mockReset();
});

const send = (extra: Record<string, unknown> = {}) =>
  uploadInChunks(file, {
    purpose: 'upload',
    filename: 'f.bin',
    retryDelayMs: () => 0,
    ...extra,
  });

describe('uploadInChunks', () => {
  it('sends the file in chunks at their offsets, then completes', async () => {
    const s = server();
    const progress: number[] = [];
    const onSent = vi.fn<() => void>();
    const out = await send({
      progressToken: 't',
      onProgress: (p: number) => progress.push(p),
      onSent,
    });
    expect(s.sent).toEqual(['01234567', '89abcdef', 'ghij']);
    expect(out).toEqual({ url: 'https://x/done', body: { progressToken: 't' } });
    expect(progress.at(-1)).toBe(100);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(h.api.mock.calls[0][1]?.body).toEqual({
      purpose: 'upload',
      size: 20,
      filename: 'f.bin',
    });
  });

  it('carries on from what the server kept of a chunk that was cut off', async () => {
    const s = server({ drop: 1, keep: 3 });
    await send();
    // The first try left "012" behind; the rest went from there.
    expect(s.sent).toEqual(['3456789a', 'bcdefghi', 'j']);
    expect(s.held).toBe(20);
    expect(s.completed).toBe(true);
  });

  it('gives up on a refusal no retry changes, and drops the session', async () => {
    server();
    h.apiSend.mockRejectedValueOnce(Object.assign(new Error('too big'), { status: 413 }));
    await expect(send()).rejects.toThrow('too big');
    expect(h.apiSend).toHaveBeenCalledTimes(1);
    expect(h.api).toHaveBeenLastCalledWith(SESSION, { method: 'DELETE' });
  });

  it('gives up after six failures in a row', async () => {
    const s = server({ drop: 99 });
    await expect(send()).rejects.toThrow('network error');
    expect(h.apiSend).toHaveBeenCalledTimes(7);
    expect(s.deleted).toBe(true);
  });
});
