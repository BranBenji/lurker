// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A file sent in chunks through an upload session (#650): one request per
// chunk, so no proxy's body limit caps the file, and a dropped request costs
// that chunk rather than the whole file. After a failure the server says where
// it got to (its offset) and sending carries on from there.

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
}

/** Failures in a row before giving up: with the default delays, about a
 *  minute for a phone to find its network again. */
const MAX_RETRIES = 6;
const defaultDelay = (n: number) => Math.min(30_000, 1000 * 2 ** (n - 1));

interface SessionStatus {
  id: string;
  offset: number;
  chunkBytes: number;
}

// A refusal no retry changes: the session is gone (404), the chunk or file is
// too large (413), the file is wrong for its purpose. A network error has no
// status; a 409 is the server telling us its offset; a 5xx may pass.
function isFinal(err: unknown): boolean {
  const status = (err as ApiError).status;
  return typeof status === 'number' && status !== 409 && status < 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  });
  const url = `/api/upload-sessions/${session.id}`;
  const report = (bytes: number) =>
    opts.onProgress?.(Math.min(100, Math.floor((bytes / file.size) * 100)));
  let offset = session.offset;
  let failures = 0;
  try {
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + session.chunkBytes);
      try {
        const res = await apiSend<{ offset: number }>('PUT', url, chunk, {
          headers: {
            'Upload-Offset': String(offset),
            'Content-Type': 'application/octet-stream',
          },
          onProgress: (loaded) => report(offset + loaded),
        });
        offset = res.offset;
        failures = 0;
      } catch (err) {
        if (isFinal(err) || ++failures > MAX_RETRIES) throw err;
        await sleep(delay(failures));
        try {
          offset = (await api<SessionStatus>(url)).offset;
        } catch (lookup) {
          if (isFinal(lookup)) throw lookup;
          // Still unreachable: the next chunk tries the offset we had, and a
          // 409 corrects it once the server answers.
        }
      }
      report(offset);
    }
    opts.onSent?.();
    return await api<T>(`${url}/complete`, {
      method: 'POST',
      body: opts.progressToken ? { progressToken: opts.progressToken } : {},
    });
  } catch (err) {
    // Done with it either way; complete ends a session on its own.
    void api(url, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}
