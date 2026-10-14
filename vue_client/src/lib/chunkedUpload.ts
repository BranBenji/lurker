// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A file sent in chunks through an upload session (#650): one request per
// chunk, so no proxy's body limit caps the file, and a dropped request costs
// that chunk rather than the whole file. After a failure the server says where
// it got to (its offset) and sending carries on from there.
//
// Finishing can take longer than a proxy waits (a 500 MB import runs for
// minutes; Cloudflare gives up at 100 s), so a complete whose answer is lost
// isn't a failure: the session keeps the answer, and this asks for it.

import { api, apiSend, type ApiError } from '../api.js';

export interface ChunkedUploadOptions {
  purpose: 'upload' | 'import';
  filename: string;
  /** Rides to complete, for the server's processing progress frames. */
  progressToken?: string;
  /** Bytes the server holds, plus the chunk in flight, as 0–100. */
  onProgress?: (percent: number) => void;
  /** Every byte is on the server; what's left is its processing. */
  onSent?: () => void;
  /** How long to wait before retry `n` (1-based). Tests make it 0. */
  retryDelayMs?: (n: number) => number;
  /** Between looks at a session the server is still processing. */
  pollMs?: number;
}

/** Failures in a row before giving up: with the default delays, about a
 *  minute for a phone to find its network again. */
const MAX_RETRIES = 6;
const defaultDelay = (n: number) => Math.min(30_000, 1000 * 2 ** (n - 1));
/** A chunk with no bytes moving and no answer for this long is dead. */
const CHUNK_STALL_MS = 60_000;
/** Creating a session or asking after one is quick; past this, it's lost. */
const ASK_MS = 30_000;
/** How long to wait on complete itself before asking the session instead. */
const COMPLETE_MS = 120_000;

interface SessionStatus {
  id: string;
  size: number;
  offset: number;
  chunkBytes: number;
  state?: 'open' | 'processing' | 'done';
  result?: { status: number; body: any };
}

// Worth trying again: no answer at all (a network error, a stall, a timeout),
// a 409 (the server telling us its offset, or that it is still busy), a 408 or
// 429, or a 5xx. Anything else is a refusal no retry changes: the session is
// gone (404), the chunk or file is too large (413), the file is wrong.
function isFinal(err: unknown): boolean {
  const status = (err as ApiError).status;
  if (typeof status !== 'number') return false;
  return status !== 409 && status !== 408 && status !== 429 && status < 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = (url: string) => api<SessionStatus>(url, { signal: AbortSignal.timeout(ASK_MS) });

/** What complete answered, as `api()` would have: the body, or its error. */
function fromResult<T>(result: { status: number; body: any }): T {
  if (result.status >= 200 && result.status < 300) return result.body as T;
  const err = new Error(result.body?.error || 'upload failed') as ApiError;
  err.status = result.status;
  err.data = result.body;
  throw err;
}

/** Send `file` through a session and finish it; resolves with what the
 *  equivalent single request would have. */
export async function uploadInChunks<T = any>(file: Blob, opts: ChunkedUploadOptions): Promise<T> {
  const delay = opts.retryDelayMs ?? defaultDelay;
  const session = await api<SessionStatus>('/api/upload-sessions', {
    method: 'POST',
    body: {
      purpose: opts.purpose,
      size: file.size,
      filename: opts.filename,
      ...(file.type ? { mime: file.type } : {}),
    },
    signal: AbortSignal.timeout(ASK_MS),
  });
  const url = `/api/upload-sessions/${session.id}`;
  try {
    await sendChunks(file, url, session, opts, delay);
  } catch (err) {
    // Done with it. (The server sweeps what is left after a day anyway.)
    void api(url, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
  opts.onSent?.();
  // Never dropped from here on: a complete whose answer we never heard may
  // have done its work, and the session is where that answer is kept.
  return finish<T>(url, opts, delay);
}

async function sendChunks(
  file: Blob,
  url: string,
  session: SessionStatus,
  opts: ChunkedUploadOptions,
  delay: (n: number) => number,
): Promise<void> {
  const report = (bytes: number) =>
    opts.onProgress?.(Math.min(100, Math.floor((bytes / file.size) * 100)));
  let offset = session.offset;
  let failures = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, offset + session.chunkBytes);
    try {
      const res = await apiSend<{ offset: number }>('PUT', url, chunk, {
        headers: {
          'Upload-Offset': String(offset),
          'Content-Type': 'application/octet-stream',
        },
        onProgress: (loaded) => report(offset + loaded),
        stallMs: CHUNK_STALL_MS,
      });
      offset = res.offset;
      failures = 0;
    } catch (err) {
      if (isFinal(err) || ++failures > MAX_RETRIES) throw err;
      await sleep(delay(failures));
      try {
        offset = (await ask(url)).offset;
      } catch (lookup) {
        if (isFinal(lookup)) throw lookup;
        // Still unreachable: the next chunk tries the offset we had, and a
        // 409 corrects it once the server answers.
      }
    }
    report(offset);
  }
}

async function finish<T>(
  url: string,
  opts: ChunkedUploadOptions,
  delay: (n: number) => number,
): Promise<T> {
  const pollMs = opts.pollMs ?? 2000;
  let failures = 0;
  let lastError: unknown = null;
  let sendComplete = true;
  for (;;) {
    if (sendComplete) {
      try {
        return await api<T>(`${url}/complete`, {
          method: 'POST',
          body: opts.progressToken ? { progressToken: opts.progressToken } : {},
          signal: AbortSignal.timeout(COMPLETE_MS),
        });
      } catch (err) {
        if (isFinal(err)) throw err;
        // Lost, timed out, or the server still busy. Whether it did the work
        // is the session's to say, even on the last try.
        lastError = err;
        failures++;
      }
    }
    await sleep(failures ? delay(failures) : pollMs);
    let s: SessionStatus;
    try {
      s = await ask(url);
    } catch (err) {
      if (isFinal(err) || ++failures > MAX_RETRIES) throw err;
      sendComplete = false;
      continue;
    }
    if (s.state === 'done' && s.result) return fromResult<T>(s.result);
    if (s.state === 'processing') {
      // The server is working on it, however long that takes.
      failures = 0;
      sendComplete = false;
      continue;
    }
    if (s.offset < s.size) throw new Error('the server lost part of the file');
    // Open and whole: complete never arrived. Ask again, within the budget.
    if (failures > MAX_RETRIES) throw lastError;
    sendComplete = true;
  }
}
