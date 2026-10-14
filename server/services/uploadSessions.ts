// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Chunked, resumable uploads (#650). A single-request upload can never be
// larger than the smallest request-body limit on the path (Cloudflare's 100 MB,
// an nginx client_max_body_size), and one that drops at 90% starts again. A
// session takes the file a chunk per request instead, each well under any
// proxy's limit, and appends it to a file on disk:
//
//   create   declares the size, checked against the purpose's cap before a
//            byte is sent
//   chunk    appends bytes at an offset, which must be exactly where the file
//            ends now; anything else is answered with the real offset
//   status   tells a client that lost track where to carry on
//   complete hands the assembled file to what a single request would have
//            (the upload pipeline, the importer), and ends the session
//
// The file's size IS the offset, so a chunk cut off halfway leaves a prefix
// of what was sent, and the client carries on from there. A session survives
// a restart (its row and file stay); one idle for a day is swept.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { resolveDataDir } from '../utils/dataDir.js';
import { hasFreeSpaceFor } from '../utils/diskSpace.js';
import {
  allUploadSessionIds,
  deleteUploadSession,
  getUploadSession,
  idleUploadSessionIds,
  insertUploadSession,
  touchUploadSession,
  type UploadPurpose,
  type UploadSessionRow,
} from '../db/uploadSessions.js';
import {
  chunkedCapBytesFor,
  effectiveSettings,
  formatCapMb,
  MAX_IMPORT_BYTES,
  uploadChunkBytes,
} from './uploadLimits.js';
import {
  resolveUploader,
  UploaderNotConfiguredError,
  UploaderUnavailableError,
} from './uploadProviders/resolve.js';
import { accountIsEmpty } from './importService.js';

/** Where sessions keep their bytes. Owner-only: an import is an archive with
 *  the source account's network passwords in it. */
export const UPLOAD_SESSION_DIR = path.join(resolveDataDir(), 'tmp', 'upload-sessions');
fs.mkdirSync(UPLOAD_SESSION_DIR, { recursive: true, mode: 0o700 });

/** A session with no chunk for this long is abandoned. */
export const UPLOAD_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

/** A refusal to answer with `status`; `extra` rides along in the JSON body. */
export class UploadSessionError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'UploadSessionError';
    this.status = status;
    this.extra = extra;
  }
}

// Sessions with a request working on their file: a chunk being written, or the
// file being handed on. A second request for one of them is refused, because
// two writers appending at once would interleave their bytes.
const busy = new Set<string>();

export function uploadSessionPath(id: string): string {
  return path.join(UPLOAD_SESSION_DIR, id);
}

/** Bytes the session holds so far: its file's size. */
export function uploadSessionOffset(id: string): number {
  try {
    return fs.statSync(uploadSessionPath(id)).size;
  } catch {
    return 0;
  }
}

export interface UploadSessionStatus {
  id: string;
  purpose: UploadPurpose;
  size: number;
  offset: number;
  chunkBytes: number;
}

function statusOf(row: UploadSessionRow): UploadSessionStatus {
  return {
    id: row.id,
    purpose: row.purpose,
    size: row.size,
    offset: uploadSessionOffset(row.id),
    chunkBytes: uploadChunkBytes(),
  };
}

/** The caller's session, or a 404. */
export function requireUploadSession(userId: number, id: string): UploadSessionRow {
  const row = typeof id === 'string' ? getUploadSession(userId, id) : undefined;
  if (!row) throw new UploadSessionError(404, 'no such upload session');
  return row;
}

export function uploadSessionStatus(userId: number, id: string): UploadSessionStatus {
  return statusOf(requireUploadSession(userId, id));
}

/** The largest file `purpose` takes for this user. An upload's cap is its
 *  uploader's (the override if one is named), without any proxy ceiling. */
function capFor(
  purpose: UploadPurpose,
  user: { id: number; isAdmin: boolean },
  uploaderId: number | null,
): number {
  if (purpose === 'import') return MAX_IMPORT_BYTES;
  try {
    const { policy } = resolveUploader({
      userId: user.id,
      isAdmin: user.isAdmin,
      requestedId: uploaderId,
    });
    return chunkedCapBytesFor(policy, effectiveSettings(user.id));
  } catch (err) {
    // As processUpload answers them, so a session fails the way a single
    // request would, only before the bytes rather than after.
    if (err instanceof UploaderNotConfiguredError) throw new UploadSessionError(503, err.message);
    if (err instanceof UploaderUnavailableError) throw new UploadSessionError(400, err.message);
    throw err;
  }
}

export function createUploadSession(
  user: { id: number; isAdmin: boolean },
  body: Record<string, unknown>,
): UploadSessionStatus {
  const purpose = body.purpose;
  if (purpose !== 'upload' && purpose !== 'import') {
    throw new UploadSessionError(400, "purpose must be 'upload' or 'import'");
  }
  const size = body.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new UploadSessionError(400, 'size must be a whole number of bytes above 0');
  }
  if (typeof body.filename !== 'string') {
    throw new UploadSessionError(400, 'filename must be a string');
  }
  // No control characters: the name goes into a provider's multipart header
  // and the uploads list (processUpload strips them too).
  const filename = body.filename.replace(/\p{Cc}/gu, '').slice(0, 255) || 'upload';
  const mime =
    typeof body.mime === 'string' && body.mime && body.mime.length <= 255 ? body.mime : null;
  let uploaderId: number | null = null;
  if (body.uploaderId != null) {
    if (purpose !== 'upload' || !Number.isInteger(body.uploaderId)) {
      throw new UploadSessionError(400, 'uploaderId must be an integer, on an upload');
    }
    uploaderId = body.uploaderId as number;
  }

  const cap = capFor(purpose, user, uploaderId);
  if (size > cap) {
    throw new UploadSessionError(
      413,
      purpose === 'import'
        ? `archive exceeds ${formatCapMb(cap)} MB`
        : `file exceeds ${formatCapMb(cap)} MB`,
      purpose === 'import' ? { code: 'archive_too_large' } : {},
    );
  }
  // The importer refuses an account with data in it. Said now, not after the
  // archive has crossed the network.
  if (purpose === 'import' && !accountIsEmpty(user.id)) {
    throw new UploadSessionError(
      409,
      'target account already has data; imports require a fresh account',
      { code: 'account_not_empty' },
    );
  }
  if (!hasFreeSpaceFor(UPLOAD_SESSION_DIR, size)) {
    throw new UploadSessionError(507, 'not enough free disk space on the server for this file');
  }

  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(uploadSessionPath(id), '', { flag: 'wx', mode: 0o600 });
  insertUploadSession(user.id, { id, purpose, size, filename, mime, uploaderId });
  return { id, purpose, size, offset: 0, chunkBytes: uploadChunkBytes() };
}

/**
 * Append one chunk, read from `body`, at `offsetHeader`. Answers the offset
 * after it. A chunk cut off partway keeps what arrived, which is a prefix of
 * what was sent; the client asks for the offset and carries on.
 */
export async function appendUploadChunk(
  userId: number,
  id: string,
  offsetHeader: unknown,
  declaredLength: number | null,
  body: Readable,
): Promise<{ offset: number }> {
  const row = requireUploadSession(userId, id);
  if (busy.has(id)) {
    throw new UploadSessionError(409, 'this upload session is busy with another request', {
      code: 'session_busy',
      offset: uploadSessionOffset(id),
    });
  }
  const offset = uploadSessionOffset(id);
  const claimed = typeof offsetHeader === 'string' ? Number(offsetHeader) : NaN;
  if (!Number.isSafeInteger(claimed) || claimed !== offset) {
    throw new UploadSessionError(409, `this upload session is at byte ${offset}`, {
      code: 'offset_mismatch',
      offset,
    });
  }
  const allowed = Math.min(uploadChunkBytes(), row.size - offset);
  if (declaredLength != null && declaredLength > allowed) {
    throw new UploadSessionError(413, `a chunk here may be at most ${allowed} bytes`, {
      code: 'chunk_too_large',
      offset,
    });
  }

  busy.add(id);
  const out = fs.createWriteStream(uploadSessionPath(id), { flags: 'a' });
  let seen = 0;
  let over = false;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > allowed) {
        over = true;
        cb(new Error('chunk too large'));
        return;
      }
      cb(null, chunk);
    },
  });
  let cutOff = false;
  try {
    await pipeline(body, limit, out);
  } catch {
    // Over the limit, or the client went away mid-chunk. A body without a
    // Content-Length is the only way past the check above, and the pipeline
    // closes its connection.
    cutOff = !over;
  } finally {
    // ⚠ Not free until the file is closed: a write still in flight would land
    // after the next chunk read the offset, and splice into it.
    if (!out.closed) await once(out, 'close');
    if (over) fs.truncateSync(uploadSessionPath(id), offset);
    busy.delete(id);
    touchUploadSession(id);
  }
  if (over) {
    throw new UploadSessionError(413, `a chunk here may be at most ${allowed} bytes`, {
      code: 'chunk_too_large',
      offset,
    });
  }
  if (cutOff) {
    throw new UploadSessionError(400, 'the chunk was cut off', {
      code: 'interrupted',
      offset: uploadSessionOffset(id),
    });
  }
  return { offset: uploadSessionOffset(id) };
}

/**
 * Hand a whole session's file to `use`, then end the session whatever `use`
 * does: the file is removed and the row with it. A session short of its size
 * is refused with the offset, and stays.
 */
export async function finishUploadSession<T>(
  userId: number,
  id: string,
  use: (row: UploadSessionRow, filePath: string) => Promise<T>,
): Promise<T> {
  const row = requireUploadSession(userId, id);
  if (busy.has(id)) {
    throw new UploadSessionError(409, 'this upload session is busy with another request', {
      code: 'session_busy',
      offset: uploadSessionOffset(id),
    });
  }
  const offset = uploadSessionOffset(id);
  if (offset !== row.size) {
    throw new UploadSessionError(409, `this upload session has ${offset} of ${row.size} bytes`, {
      code: 'incomplete',
      offset,
    });
  }
  busy.add(id);
  try {
    return await use(row, uploadSessionPath(id));
  } finally {
    endSession(id);
    busy.delete(id);
  }
}

/** Remove the session and its file. The local upload driver may have renamed
 *  the file away already, which is the good case. */
function endSession(id: string): void {
  deleteUploadSession(id);
  fs.promises.unlink(uploadSessionPath(id)).catch(() => {});
}

/** The caller gives up on a session. Not while a request is working on it:
 *  a complete whose answer never reached the client may still be handing the
 *  file on, and a chunk in flight ends with its connection anyway. The sweep
 *  takes what is left. */
export function abortUploadSession(userId: number, id: string): void {
  requireUploadSession(userId, id);
  if (busy.has(id)) {
    throw new UploadSessionError(409, 'this upload session is busy with another request', {
      code: 'session_busy',
      offset: uploadSessionOffset(id),
    });
  }
  endSession(id);
}

/**
 * Remove sessions idle for a day, and files under the session dir that no
 * session owns (a session whose account was deleted, a crash between writing
 * the file and the row) once they are as old. Skips a session a request is
 * working on.
 */
export async function sweepUploadSessions(now = Date.now()): Promise<number> {
  const cutoff = now - UPLOAD_SESSION_IDLE_MS;
  let removed = 0;
  for (const id of idleUploadSessionIds(new Date(cutoff).toISOString())) {
    if (busy.has(id)) continue;
    endSession(id);
    removed++;
  }
  let names: string[];
  try {
    names = await fs.promises.readdir(UPLOAD_SESSION_DIR);
  } catch {
    names = [];
  }
  const owned = allUploadSessionIds();
  for (const name of names) {
    if (owned.has(name) || busy.has(name)) continue;
    const full = path.join(UPLOAD_SESSION_DIR, name);
    try {
      if ((await fs.promises.stat(full)).mtimeMs < cutoff) {
        await fs.promises.unlink(full);
        removed++;
      }
    } catch {
      // gone already
    }
  }
  if (removed > 0) console.log(`[lurker] swept ${removed} abandoned upload session(s)`);
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Sweep now and every hour after. */
export function startUploadSessionSweeper(): void {
  if (sweepTimer) return;
  const run = () =>
    void sweepUploadSessions().catch((err: unknown) => {
      console.warn('[lurker] upload session sweep failed:', (err as Error).message);
    });
  run();
  sweepTimer = setInterval(run, 60 * 60 * 1000);
  sweepTimer.unref();
}

export function stopUploadSessionSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
