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
// their bytes arrived. `lostCompletes` complete calls are processed but their
// answer never arrives, and the session then reads 'processing' for
// `processingPolls` looks before it is done with `result`.
function server({
  drop = 0,
  keep = 0,
  lostCompletes = 0,
  processingPolls = 0,
  result = { status: 200, body: { url: 'https://x/stored' } as Record<string, unknown> },
} = {}) {
  const state = {
    held: 0,
    drop,
    sent: [] as string[],
    completes: 0,
    deleted: false,
    session: 'open' as 'open' | 'processing' | 'done',
    polls: 0,
  };
  h.api.mockImplementation(async (url, opts) => {
    if (url === '/api/upload-sessions') return { id: 's1', offset: 0, chunkBytes: 8 };
    if (url === SESSION && opts?.method === 'DELETE') {
      state.deleted = true;
      return { ok: true };
    }
    if (url === SESSION) {
      if (state.session === 'processing' && state.polls++ >= processingPolls)
        state.session = 'done';
      return {
        offset: state.held,
        size: 20,
        state: state.session,
        ...(state.session === 'done' ? { result } : {}),
      };
    }
    if (url === `${SESSION}/complete`) {
      state.completes++;
      if (state.session === 'open' && lostCompletes > 0) {
        lostCompletes--;
        state.session = 'processing';
        throw new Error('network error');
      }
      state.session = 'done';
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
    pollMs: 0,
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
    expect(s.completes).toBe(1);
  });

  it('gives up on a refusal no retry changes, and drops the session', async () => {
    server();
    h.apiSend.mockRejectedValueOnce(Object.assign(new Error('too big'), { status: 413 }));
    await expect(send()).rejects.toThrow('too big');
    expect(h.apiSend).toHaveBeenCalledTimes(1);
    expect(h.api).toHaveBeenLastCalledWith(SESSION, { method: 'DELETE' });
  });

  it('retries a chunk a proxy timed out or rate-limited', async () => {
    const s = server();
    h.apiSend.mockRejectedValueOnce(Object.assign(new Error('timeout'), { status: 408 }));
    h.apiSend.mockRejectedValueOnce(Object.assign(new Error('slow down'), { status: 429 }));
    await send();
    expect(s.held).toBe(20);
  });

  // A 500 MB import outlasts Cloudflare's 100 s: the answer is lost, the work isn't.
  it('reads the answer from the session when complete’s own answer is lost', async () => {
    const s = server({ lostCompletes: 1, processingPolls: 2 });
    await expect(send()).resolves.toEqual({ url: 'https://x/stored' });
    expect(s.completes).toBe(1); // asked once; the session had the rest
    expect(s.deleted).toBe(false);
  });

  // The last try may be the one that worked, its answer lost with the rest.
  it('asks the session before giving up on complete, and never drops it', async () => {
    const s = server();
    const real = h.api.getMockImplementation()!;
    let attempts = 0;
    h.api.mockImplementation(async (url, opts) => {
      if (url === `${SESSION}/complete`) {
        attempts++;
        if (attempts === 7) await real(url, opts); // done, but unheard
        throw new Error('network error');
      }
      return real(url, opts);
    });
    await expect(send()).resolves.toEqual({ url: 'https://x/stored' });
    expect(attempts).toBe(7);
    expect(s.deleted).toBe(false);
  });

  it('gives up on complete after six lost tries, keeping the session', async () => {
    const s = server();
    const real = h.api.getMockImplementation()!;
    h.api.mockImplementation(async (url, opts) => {
      if (url === `${SESSION}/complete`) throw new Error('network error');
      return real(url, opts);
    });
    await expect(send()).rejects.toThrow('network error');
    expect(s.deleted).toBe(false);
  });

  it('throws the stored refusal as the request would have', async () => {
    server({
      lostCompletes: 1,
      result: { status: 400, body: { error: 'not a zip', code: 'not_a_zip' } },
    });
    await expect(send()).rejects.toMatchObject({
      message: 'not a zip',
      status: 400,
      data: { code: 'not_a_zip' },
    });
  });

  it('asks complete again once the server stops being busy', async () => {
    const s = server();
    const real = h.api.getMockImplementation()!;
    let busyOnce = true;
    h.api.mockImplementation(async (url, opts) => {
      if (url === `${SESSION}/complete` && busyOnce) {
        busyOnce = false;
        throw Object.assign(new Error('busy'), { status: 409 });
      }
      return real(url, opts);
    });
    await expect(send()).resolves.toMatchObject({ url: 'https://x/done' });
    expect(s.completes).toBe(1);
  });

  it('gives up after six failures in a row', async () => {
    const s = server({ drop: 99 });
    await expect(send()).rejects.toThrow('network error');
    expect(h.apiSend).toHaveBeenCalledTimes(7);
    expect(s.deleted).toBe(true);
  });
});
