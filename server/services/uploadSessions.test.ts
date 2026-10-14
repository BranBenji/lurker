// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Upload sessions (#650) below the router: a chunk cut off partway, two
// writers at once, and the sweep. The router's own tests are in
// routes/uploadSessions.test.ts.

import '../test-utils/isolateDb.js';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import db from '../db/index.js';
import { createUser } from '../db/users.js';
import { setUploadChunkBytesForTests } from './uploadLimits.js';
import {
  abortUploadSession,
  appendUploadChunk,
  createUploadSession,
  sweepUploadSessions,
  UPLOAD_SESSION_DIR,
  UPLOAD_SESSION_IDLE_MS,
  uploadSessionOffset,
  uploadSessionPath,
  uploadSessionStatus,
} from './uploadSessions.js';

let user: { id: number; isAdmin: boolean };
beforeAll(() => {
  user = { id: createUser('sess-svc').id, isAdmin: false };
  setUploadChunkBytesForTests(64);
});
afterAll(() => setUploadChunkBytesForTests(null));

const open = (size = 64) =>
  createUploadSession(user, { purpose: 'import', size, filename: 'a.lurk' }).id;

describe('a chunk', () => {
  it('cut off partway keeps what arrived, and the offset says so', async () => {
    const id = open();
    const body = new PassThrough();
    const pending = appendUploadChunk(user.id, id, '0', 64, body);
    body.write(Buffer.from('hello'));
    await new Promise((r) => setTimeout(r, 20));
    body.destroy(new Error('socket hang up'));
    await expect(pending).rejects.toMatchObject({
      status: 400,
      extra: { code: 'interrupted', offset: 5 },
    });
    expect(fs.readFileSync(uploadSessionPath(id), 'utf8')).toBe('hello');
    expect(uploadSessionStatus(user.id, id).offset).toBe(5);
  });

  it('is refused while another is still being written to the same session', async () => {
    const id = open();
    const first = new PassThrough();
    const pending = appendUploadChunk(user.id, id, '0', 10, first);
    first.write(Buffer.from('12345'));
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      appendUploadChunk(user.id, id, '0', 5, PassThrough.from([Buffer.from('xxxxx')])),
    ).rejects.toMatchObject({ status: 409, extra: { code: 'session_busy' } });
    first.end(Buffer.from('67890'));
    await expect(pending).resolves.toEqual({ offset: 10 });
    expect(fs.readFileSync(uploadSessionPath(id), 'utf8')).toBe('1234567890');
  });

  // A complete whose answer was lost may still be handing the file on.
  it('keeps its session from being dropped while it is written', async () => {
    const id = open();
    const body = new PassThrough();
    const pending = appendUploadChunk(user.id, id, '0', 4, body);
    expect(() => abortUploadSession(user.id, id)).toThrow(/busy/);
    body.end(Buffer.from('abcd'));
    await pending;
    abortUploadSession(user.id, id);
    expect(() => uploadSessionStatus(user.id, id)).toThrow(/no such upload session/);
  });

  // No Content-Length to check up front: the bytes past the limit are the tell.
  it('that runs past the limit with no declared length leaves the file as it was', async () => {
    const id = open(100);
    await appendUploadChunk(user.id, id, '0', null, PassThrough.from([Buffer.alloc(10, 97)]));
    // 60 bytes land before the 10 that cross the 64.
    const body = new PassThrough();
    const pending = appendUploadChunk(user.id, id, '10', null, body);
    body.write(Buffer.alloc(60, 98));
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadSessionOffset(id)).toBe(70);
    body.end(Buffer.alloc(10, 98));
    await expect(pending).rejects.toMatchObject({
      status: 413,
      extra: { code: 'chunk_too_large', offset: 10 },
    });
    expect(uploadSessionOffset(id)).toBe(10);
  });

  it('declared larger than the limit is refused before a byte is read', async () => {
    const id = open(100);
    const unread = new PassThrough(); // never ends: only the declared length can refuse it
    await expect(appendUploadChunk(user.id, id, '0', 65, unread)).rejects.toMatchObject({
      status: 413,
      extra: { code: 'chunk_too_large', offset: 0 },
    });
  });
});

describe('sweepUploadSessions', () => {
  it('removes a session a day idle and an unowned file as old, and nothing newer', async () => {
    const idle = open();
    const fresh = open();
    const old = new Date(Date.now() - UPLOAD_SESSION_IDLE_MS - 60_000);
    db.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?').run(
      old.toISOString(),
      idle,
    );
    const orphan = path.join(UPLOAD_SESSION_DIR, 'orphan-from-a-crash');
    const newOrphan = path.join(UPLOAD_SESSION_DIR, 'orphan-just-now');
    fs.writeFileSync(orphan, 'x');
    fs.writeFileSync(newOrphan, 'x');
    fs.utimesSync(orphan, old, old);
    // A live session's file is its own however old, never an orphan.
    fs.utimesSync(uploadSessionPath(fresh), old, old);

    await sweepUploadSessions();
    await new Promise((r) => setTimeout(r, 20)); // a session's unlink is fire-and-forget

    expect(() => uploadSessionStatus(user.id, idle)).toThrow(/no such upload session/);
    expect(fs.existsSync(uploadSessionPath(idle))).toBe(false);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(uploadSessionStatus(user.id, fresh).offset).toBe(0);
    expect(fs.existsSync(uploadSessionPath(fresh))).toBe(true);
    expect(fs.existsSync(newOrphan)).toBe(true);
    fs.rmSync(newOrphan);
  });

  it('counts a chunk as activity', async () => {
    const id = open();
    const old = new Date(Date.now() - UPLOAD_SESSION_IDLE_MS - 60_000).toISOString();
    db.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?').run(old, id);
    await appendUploadChunk(user.id, id, '0', 3, PassThrough.from([Buffer.from('abc')]));
    await sweepUploadSessions();
    expect(uploadSessionStatus(user.id, id).offset).toBe(3);
  });
});
