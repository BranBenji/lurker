// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import { Readable } from 'stream';
import os from 'os';
import path from 'path';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-dcc');

// What each delete tells the user's other tabs.
const fanOut = vi.hoisted(() =>
  vi.fn<(userId: number, payload: Record<string, unknown>) => void>(),
);
vi.mock('../services/wsHub.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wsHub.js')>()),
  fanOutToUser: fanOut,
}));

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let carolAgent: LurkerTestAgent;
let daveAgent: LurkerTestAgent;
let alice: User;
let aliceNet: Network;
let tmpRoot: string;

let insertDccTransfer: typeof import('../db/dccTransfers.js').insertDccTransfer;
let markDccReceiving: typeof import('../db/dccTransfers.js').markDccReceiving;
let markDccCompleted: typeof import('../db/dccTransfers.js').markDccCompleted;

const BYTES = Buffer.from('0123456789abcdef');

// A transfer row for alice, its file written at `dir/name` unless `write` is
// false. `complete` false leaves it mid-receive.
function transfer(
  dir: string,
  name: string,
  { complete = true, write = true }: { complete?: boolean; write?: boolean } = {},
): number {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  if (write) fs.writeFileSync(dest, BYTES);
  const id = insertDccTransfer(alice.id, {
    network_id: aliceNet.id,
    peer_nick: 'bot',
    filename: name,
    advertised_size: BYTES.length,
    state: 'pending_approval',
  });
  markDccReceiving(id, { filename: name, advertised_size: BYTES.length, destination_path: dest });
  if (complete) markDccCompleted(id, BYTES.length, null, 'absent');
  return id;
}

function getBytes(agent: LurkerTestAgent, url: string, range?: string) {
  const req = agent.get(url);
  if (range) req.set('Range', range);
  return req.buffer(true).parse((stream, cb) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  process.env.LURKER_DCC_ENABLED = '1';
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-route-'));
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { setUserCapability, CAPABILITY_DCC_CHAT, CAPABILITY_DCC_RECEIVE } =
    await import('../db/userCapabilities.js');
  ({ insertDccTransfer, markDccReceiving, markDccCompleted } =
    await import('../db/dccTransfers.js'));
  const { default: dccRouter } = await import('./dcc.js');

  alice = createUser('dcc-alice');
  const bob = createUser('dcc-bob');
  const carol = createUser('dcc-carol');
  // Chat without files (#1080).
  const dave = createUser('dcc-dave');
  for (const u of [alice, bob]) {
    setUserCapability(u.id, CAPABILITY_DCC_CHAT, true);
    setUserCapability(u.id, CAPABILITY_DCC_RECEIVE, true);
  }
  setUserCapability(dave.id, CAPABILITY_DCC_CHAT, true);
  aliceNet = createNetwork(alice.id, {
    name: 'rizon',
    host: 'irc.rizon.net',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!;
  app = createTestApp({ '/api/dcc': dccRouter });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
  carolAgent = await createAuthedAgent(app, carol.id);
  daveAgent = await createAuthedAgent(app, dave.id);
});

afterAll(() => {
  delete process.env.LURKER_DCC_ENABLED;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  ctx.cleanup();
});

// Settings asks this to say whether DCC is on for the account, so it answers
// rather than 403ing like the rest of /api/dcc.
describe('GET /api/dcc/config', () => {
  // The server's paths are the admin's business (Admin → DCC), never a
  // member's: nothing in the answer names a directory.
  it('reports the limits, but no path, to an account with DCC', async () => {
    process.env.LURKER_DCC_DIR = path.join(tmpRoot, 'root');
    process.env.LURKER_DCC_MAX_FILE_MB = '100';
    try {
      const res = await aliceAgent.get('/api/dcc/config');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        chat: true,
        receive: true,
        maxFileBytes: 100 * 1024 * 1024,
        allowPrivateHosts: false,
        usedBytes: expect.any(Number),
        limitBytes: null,
      });
    } finally {
      delete process.env.LURKER_DCC_DIR;
      delete process.env.LURKER_DCC_MAX_FILE_MB;
    }
  });

  it('answers, not 403s, an account without a grant', async () => {
    const res = await carolAgent.get('/api/dcc/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chat: false, receive: false });
  });

  it('reports what the account uses, and its limit', async () => {
    const { setDccStorageLimit } = await import('../db/dccStorageLimits.js');
    const before = (await aliceAgent.get('/api/dcc/config')).body.usedBytes as number;
    transfer(path.join(tmpRoot, 'usage'), 'counted.mkv');
    setDccStorageLimit(alice.id, 10 * 1024 * 1024);
    try {
      const res = await aliceAgent.get('/api/dcc/config');
      expect(res.body).toMatchObject({
        usedBytes: before + BYTES.length,
        limitBytes: 10 * 1024 * 1024,
      });
    } finally {
      setDccStorageLimit(alice.id, null);
    }
  });

  it('reports chat alone, with no receiving limits, for a chat-only account', async () => {
    expect((await daveAgent.get('/api/dcc/config')).body).toEqual({ chat: true, receive: false });
  });

  it('is off for everyone while the instance switch is off', async () => {
    delete process.env.LURKER_DCC_ENABLED;
    try {
      expect((await aliceAgent.get('/api/dcc/config')).body).toEqual({
        chat: false,
        receive: false,
      });
    } finally {
      process.env.LURKER_DCC_ENABLED = '1';
    }
  });
});

// #1125: a user with a storage limit makes room by deleting what they received.
describe('DELETE /api/dcc/:id/file', () => {
  const getRow = async (id: number) =>
    (await import('../db/dccTransfers.js')).getDccTransfer(alice.id, id)!;

  it('removes a finished file and keeps the row, marked deleted', async () => {
    const dir = path.join(tmpRoot, 'del');
    const id = transfer(dir, 'gone.mkv');
    const res = await aliceAgent.delete(`/api/dcc/${id}/file`);
    expect(res.status).toBe(200);
    expect(res.body.transfer.file_deleted_at).toBeTruthy();
    expect(res.body.transfer.state).toBe('completed');
    expect(fs.existsSync(path.join(dir, 'gone.mkv'))).toBe(false);
    expect((await aliceAgent.get(`/api/dcc/${id}/file`)).status).toBe(410);
    expect((await aliceAgent.delete(`/api/dcc/${id}/file`)).status).toBe(404);
  });

  // Progress is checkpointed every few seconds, so a cancel with no receiver
  // to ask (the network offline, or a row a restart left behind) records what
  // is on disk, or the partial would count for less than it takes.
  it('records the bytes on disk when a transfer is cancelled offline', async () => {
    const dir = path.join(tmpRoot, 'cancel-bytes');
    const id = transfer(dir, 'half.mkv', { complete: false }); // 16 bytes on disk, row says 0
    expect((await getRow(id)).received_bytes).toBe(0);
    expect((await aliceAgent.post(`/api/dcc/${id}/cancel`)).status).toBe(200);
    const row = await getRow(id);
    expect(row.state).toBe('cancelled');
    expect(row.received_bytes).toBe(BYTES.length);
  });

  it('refuses while the transfer is in flight', async () => {
    const dir = path.join(tmpRoot, 'del-active');
    const id = transfer(dir, 'busy.mkv', { complete: false });
    expect((await aliceAgent.delete(`/api/dcc/${id}/file`)).status).toBe(409);
    expect(fs.existsSync(path.join(dir, 'busy.mkv'))).toBe(true);
  });

  // A path belongs to one row. When a newer transfer takes it (the name came
  // free after its file was removed by hand, or a resume continued the older
  // row's partial), the older row lets go: it can't delete the newer file.
  // A resume continues an earlier transfer's partial under a new row. (A kept
  // file's path is never taken: a new receive goes elsewhere, #1133.)
  it('leaves a file that a newer transfer took over alone', async () => {
    const { updateDccTransferState } = await import('../db/dccTransfers.js');
    const dir = path.join(tmpRoot, 'del-reused');
    const older = transfer(dir, 'ep.mkv', { complete: false });
    updateDccTransferState(older, 'failed', 'interrupted');
    const newer = transfer(dir, 'ep.mkv');
    expect((await getRow(older)).destination_path).toBeNull();
    expect((await aliceAgent.delete(`/api/dcc/${older}/file`)).status).toBe(404);
    expect(fs.existsSync(path.join(dir, 'ep.mkv'))).toBe(true);
    expect((await getBytes(aliceAgent, `/api/dcc/${newer}/file`)).status).toBe(200);
  });

  it('deletes a resumed file through the row that finished it', async () => {
    const { updateDccTransferState } = await import('../db/dccTransfers.js');
    const dir = path.join(tmpRoot, 'del-resumed');
    const first = transfer(dir, 'long.mkv', { complete: false });
    updateDccTransferState(first, 'failed', 'interrupted');
    const resumed = transfer(dir, 'long.mkv');
    expect((await aliceAgent.delete(`/api/dcc/${resumed}/file`)).status).toBe(200);
    expect(fs.existsSync(path.join(dir, 'long.mkv'))).toBe(false);
  });

  it('is 404 for another user’s transfer', async () => {
    const id = transfer(path.join(tmpRoot, 'del-owned'), 'mine.mkv');
    expect((await bobAgent.delete(`/api/dcc/${id}/file`)).status).toBe(404);
  });

  // Like reading and downloading, deleting what you received needs no grant.
  it('works after the receive grant is revoked', async () => {
    const { setUserCapability, CAPABILITY_DCC_RECEIVE } = await import('../db/userCapabilities.js');
    const id = transfer(path.join(tmpRoot, 'del-revoked'), 'kept.mkv');
    setUserCapability(alice.id, CAPABILITY_DCC_RECEIVE, false);
    try {
      expect((await aliceAgent.delete(`/api/dcc/${id}/file`)).status).toBe(200);
    } finally {
      setUserCapability(alice.id, CAPABILITY_DCC_RECEIVE, true);
    }
  });
});

describe('GET /api/dcc/:id/file', () => {
  it('serves a completed file as an attachment', async () => {
    const id = transfer(path.join(tmpRoot, 'plain'), 'show.mkv');
    const res = await getBytes(aliceAgent, `/api/dcc/${id}/file`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(BYTES);
    expect(res.headers['content-disposition']).toBe('attachment; filename="show.mkv"');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('honours a Range request', async () => {
    const id = transfer(path.join(tmpRoot, 'range'), 'big.bin');
    const res = await getBytes(aliceAgent, `/api/dcc/${id}/file`, 'bytes=4-9');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 4-9/${BYTES.length}`);
    expect(res.body).toEqual(BYTES.subarray(4, 10));
  });

  // The web client checks with a HEAD before handing the URL to the browser, so
  // a refusal shows on the row instead of being saved as a file.
  it('answers HEAD with the same status and no body', async () => {
    const ok = transfer(path.join(tmpRoot, 'head'), 'head.mkv');
    const okRes = await aliceAgent.head(`/api/dcc/${ok}/file`);
    expect(okRes.status).toBe(200);
    expect(okRes.headers['content-length']).toBe(String(BYTES.length));
    const gone = transfer(path.join(tmpRoot, 'head-gone'), 'gone.mkv', { write: false });
    expect((await aliceAgent.head(`/api/dcc/${gone}/file`)).status).toBe(410);
  });

  // A browser resuming a file it already has whole asks for bytes past the end.
  it('answers an unsatisfiable Range with 416, not a server error', async () => {
    const id = transfer(path.join(tmpRoot, 'range416'), 'whole.bin');
    const res = await aliceAgent.get(`/api/dcc/${id}/file`).set('Range', 'bytes=100-200');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${BYTES.length}`);
  });

  // The peer picks the name, so it picks the extension. Nothing it names may
  // render on our origin.
  it('never serves a peer-named type, whatever the extension', async () => {
    const id = transfer(path.join(tmpRoot, 'html'), 'page.html');
    const res = await getBytes(aliceAgent, `/api/dcc/${id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  // send refuses a dot-component anywhere in a root-less path by default, and
  // `~/.lurker/dcc` is an ordinary place to put the download dir.
  it('serves files under a dot-directory, and dot-named files', async () => {
    const dir = path.join(tmpRoot, '.lurker', 'dcc', 'dcc-alice');
    const a = await getBytes(aliceAgent, `/api/dcc/${transfer(dir, 'ep01.mkv')}/file`);
    expect(a.status).toBe(200);
    const b = await getBytes(aliceAgent, `/api/dcc/${transfer(dir, '.hidden')}/file`);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(BYTES);
  });

  it("is 404 for another user's transfer", async () => {
    const id = transfer(path.join(tmpRoot, 'owned'), 'mine.mkv');
    const res = await bobAgent.get(`/api/dcc/${id}/file`);
    expect(res.status).toBe(404);
  });

  it('is 404 for a non-numeric or unknown id', async () => {
    expect((await aliceAgent.get('/api/dcc/abc/file')).status).toBe(404);
    expect((await aliceAgent.get('/api/dcc/999999/file')).status).toBe(404);
  });

  it('is 409 for a transfer still receiving', async () => {
    const id = transfer(path.join(tmpRoot, 'partial'), 'half.mkv', { complete: false });
    const res = await aliceAgent.get(`/api/dcc/${id}/file`);
    expect(res.status).toBe(409);
    expect(res.body.state).toBe('receiving');
  });

  it('is 410 when the completed file is gone from disk', async () => {
    const id = transfer(path.join(tmpRoot, 'gone'), 'deleted.mkv', { write: false });
    const res = await aliceAgent.get(`/api/dcc/${id}/file`);
    expect(res.status).toBe(410);
  });

  // The path is free once the file is removed, so a later offer of the same
  // name can be writing there. That file is not this transfer's.
  it('is 410 when the file at the path is not the one this transfer received', async () => {
    const dir = path.join(tmpRoot, 'reused');
    const id = transfer(dir, 'show.mkv');
    fs.writeFileSync(path.join(dir, 'show.mkv'), BYTES.subarray(0, 5));
    const res = await aliceAgent.get(`/api/dcc/${id}/file`);
    expect(res.status).toBe(410);
  });

  // send drops a read error that comes after the headers, so without an
  // explicit end the browser waits forever for the advertised length.
  it('ends the response when the read fails partway', async () => {
    const id = transfer(path.join(tmpRoot, 'eio'), 'flaky.mkv');
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(() => {
      let sent = false;
      return new Readable({
        read() {
          if (sent) {
            this.destroy(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));
            return;
          }
          sent = true;
          this.push(BYTES.subarray(0, 4));
        },
      }) as unknown as fs.ReadStream;
    });
    try {
      const outcome = await getBytes(aliceAgent, `/api/dcc/${id}/file`)
        .timeout(2000)
        .then(
          () => 'completed',
          (err: { timeout?: number }) => (err.timeout ? 'hung' : 'ended'),
        );
      expect(outcome).toBe('ended');
    } finally {
      spy.mockRestore();
    }
  });

  // A revoked grant stops what starts next; what the account already received
  // stays its own, and stopping things never needs a grant (#1080).
  it('after the receive grant is revoked: serves files, refuses accept, allows reject', async () => {
    const { setUserCapability, CAPABILITY_DCC_RECEIVE } = await import('../db/userCapabilities.js');
    const id = transfer(path.join(tmpRoot, 'revoked'), 'kept.mkv');
    const offer = insertDccTransfer(alice.id, {
      network_id: aliceNet.id,
      peer_nick: 'bot',
      filename: 'offered.mkv',
      advertised_size: 10,
      state: 'pending_approval',
    });
    setUserCapability(alice.id, CAPABILITY_DCC_RECEIVE, false);
    try {
      expect((await getBytes(aliceAgent, `/api/dcc/${id}/file`)).status).toBe(200);
      const list = await aliceAgent.get('/api/dcc');
      expect(list.body.transfers.some((t: { id: number }) => t.id === id)).toBe(true);
      const accept = await aliceAgent.post(`/api/dcc/${offer}/accept`);
      expect(accept.status).toBe(403);
      expect(accept.body.error).toMatch(/receiving/);
      expect((await aliceAgent.post(`/api/dcc/${offer}/reject`)).status).toBe(200);
    } finally {
      setUserCapability(alice.id, CAPABILITY_DCC_RECEIVE, true);
    }
  });

  // Chat without files: the chat routes pass the gate (the 400 is the body
  // check behind it), file actions do not.
  it('lets a chat-only account offer chats but not accept files', async () => {
    expect((await daveAgent.post('/api/dcc/chat').send({})).status).toBe(400);
    const accept = await daveAgent.post('/api/dcc/1/accept');
    expect(accept.status).toBe(403);
    expect(accept.body.error).toMatch(/receiving/);
  });

  it('refuses a chat offer from an account without the chat grant', async () => {
    const res = await carolAgent.post('/api/dcc/chat').send({ networkId: 1, nick: 'bob' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/chat/);
  });

  it('is dark for everyone while the instance switch is off', async () => {
    const id = transfer(path.join(tmpRoot, 'dark'), 'dark.mkv');
    delete process.env.LURKER_DCC_ENABLED;
    try {
      expect((await aliceAgent.get(`/api/dcc/${id}/file`)).status).toBe(403);
      expect((await aliceAgent.get('/api/dcc')).status).toBe(403);
    } finally {
      process.env.LURKER_DCC_ENABLED = '1';
    }
  });
});

// #1133: a received file is the account's, apart from the transfer that
// received it.
describe('/api/dcc/files', () => {
  const fileOf = async (transferId: number) => {
    const res = await aliceAgent.get('/api/dcc/files');
    return (res.body.files as { transfer_id: number | null; id: number }[]).find(
      (f) => f.transfer_id === transferId,
    )!;
  };

  it('lists what the account keeps, with where it came from, and never a path', async () => {
    const id = transfer(path.join(tmpRoot, 'files-list'), 'kept.mkv');
    const file = await fileOf(id);
    expect(file).toEqual({
      id: expect.any(Number),
      name: 'kept.mkv',
      size: BYTES.length,
      origin: 'received',
      created_at: expect.any(String),
      transfer_id: id,
      peer_nick: 'bot',
      network_id: aliceNet.id,
    });
  });

  it('lists nothing for an unfinished transfer: its partial is still its own', async () => {
    const id = transfer(path.join(tmpRoot, 'files-partial'), 'part.mkv', { complete: false });
    expect(await fileOf(id)).toBeUndefined();
  });

  it('serves a kept file by its id, Range and all', async () => {
    const id = transfer(path.join(tmpRoot, 'files-get'), 'get.mkv');
    const file = await fileOf(id);
    const whole = await getBytes(aliceAgent, `/api/dcc/files/${file.id}/file`);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-disposition']).toContain('get.mkv');
    expect(Buffer.compare(whole.body, BYTES)).toBe(0);
    const part = await getBytes(aliceAgent, `/api/dcc/files/${file.id}/file`, 'bytes=0-1');
    expect(part.status).toBe(206);
  });

  it('deletes a kept file, and its transfer stays as history, marked deleted', async () => {
    const dir = path.join(tmpRoot, 'files-del');
    const id = transfer(dir, 'del.mkv');
    const file = await fileOf(id);
    expect((await aliceAgent.delete(`/api/dcc/files/${file.id}`)).body).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, 'del.mkv'))).toBe(false);
    // Every tab drops the file, and redraws its transfer as deleted.
    expect(fanOut).toHaveBeenCalledWith(alice.id, { kind: 'dcc-file-deleted', id: file.id });
    expect(fanOut).toHaveBeenCalledWith(alice.id, {
      kind: 'dcc-transfer',
      transfer: expect.objectContaining({ id, file_deleted_at: expect.any(String) }),
    });
    expect(await fileOf(id)).toBeUndefined();
    const { getDccTransfer } = await import('../db/dccTransfers.js');
    expect(getDccTransfer(alice.id, id)).toMatchObject({
      state: 'completed',
      file_id: null,
      destination_path: null,
      file_deleted_at: expect.any(String),
    });
    expect((await aliceAgent.get(`/api/dcc/${id}/file`)).status).toBe(410);
    expect((await aliceAgent.delete(`/api/dcc/files/${file.id}`)).status).toBe(404);
  });

  it('is the same file when deleted through its transfer', async () => {
    const id = transfer(path.join(tmpRoot, 'files-del-t'), 'via.mkv');
    const file = await fileOf(id);
    expect((await aliceAgent.delete(`/api/dcc/${id}/file`)).status).toBe(200);
    expect(await fileOf(id)).toBeUndefined();
    expect(fanOut).toHaveBeenCalledWith(alice.id, { kind: 'dcc-file-deleted', id: file.id });
    expect((await aliceAgent.get(`/api/dcc/files/${file.id}/file`)).status).toBe(404);
  });

  it('is 404 for another account’s file', async () => {
    const id = transfer(path.join(tmpRoot, 'files-owned'), 'mine.mkv');
    const file = await fileOf(id);
    expect((await bobAgent.get(`/api/dcc/files/${file.id}/file`)).status).toBe(404);
    expect((await bobAgent.delete(`/api/dcc/files/${file.id}`)).status).toBe(404);
    expect(((await bobAgent.get('/api/dcc/files')).body.files as unknown[]).length).toBe(0);
    expect((await aliceAgent.get(`/api/dcc/files/abc/file`)).status).toBe(404);
  });

  it('is 410 for a kept file gone from disk', async () => {
    const dir = path.join(tmpRoot, 'files-gone');
    const id = transfer(dir, 'gone.mkv');
    fs.rmSync(path.join(dir, 'gone.mkv'));
    expect((await aliceAgent.get(`/api/dcc/files/${(await fileOf(id)).id}/file`)).status).toBe(410);
  });
});

// A finished transfer is history once its file is kept (#1133): clearing it
// takes it off the list and leaves the file.
describe('clearing transfers', () => {
  const ids = async () =>
    ((await aliceAgent.get('/api/dcc')).body.transfers as { id: number }[]).map((t) => t.id);
  const files = async () =>
    (await aliceAgent.get('/api/dcc/files')).body.files as {
      id: number;
      name: string;
      transfer_id: number | null;
      peer_nick: string | null;
      network_id: number | null;
    }[];

  it('clears one, keeping its file and who sent it', async () => {
    const dir = path.join(tmpRoot, 'clear-one');
    const id = transfer(dir, 'keep.mkv');
    const res = await aliceAgent.delete(`/api/dcc/${id}`);
    expect(res.body).toEqual({ ids: [id] });
    expect(fanOut).toHaveBeenCalledWith(alice.id, { kind: 'dcc-transfers-cleared', ids: [id] });
    expect(await ids()).not.toContain(id);
    expect(fs.existsSync(path.join(dir, 'keep.mkv'))).toBe(true);
    const file = (await files()).find((f) => f.name === 'keep.mkv')!;
    expect(file).toMatchObject({ transfer_id: null, peer_nick: 'bot', network_id: aliceNet.id });
    const bytes = await getBytes(aliceAgent, `/api/dcc/files/${file.id}/file`);
    expect(Buffer.compare(bytes.body, BYTES)).toBe(0);
  });

  it('deletes a partial with the transfer that holds it', async () => {
    const { updateDccTransferState } = await import('../db/dccTransfers.js');
    const dir = path.join(tmpRoot, 'clear-partial');
    const id = transfer(dir, 'half.mkv', { complete: false });
    updateDccTransferState(id, 'failed', 'interrupted');
    expect((await aliceAgent.delete(`/api/dcc/${id}`)).status).toBe(200);
    expect(fs.existsSync(path.join(dir, 'half.mkv'))).toBe(false);
    expect(await ids()).not.toContain(id);
  });

  it('refuses one still in flight, and another account’s', async () => {
    const id = transfer(path.join(tmpRoot, 'clear-active'), 'busy.mkv', { complete: false });
    expect((await aliceAgent.delete(`/api/dcc/${id}`)).status).toBe(409);
    const done = transfer(path.join(tmpRoot, 'clear-owned'), 'mine.mkv');
    expect((await bobAgent.delete(`/api/dcc/${done}`)).status).toBe(404);
    expect((await aliceAgent.delete('/api/dcc/abc')).status).toBe(404);
    expect(await ids()).toEqual(expect.arrayContaining([id, done]));
  });

  it('clears every finished one but those in flight or holding a partial', async () => {
    const { updateDccTransferState } = await import('../db/dccTransfers.js');
    const dir = path.join(tmpRoot, 'clear-all');
    const done = transfer(dir, 'a.mkv');
    const active = transfer(dir, 'b.mkv', { complete: false });
    const partial = transfer(dir, 'c.mkv', { complete: false });
    updateDccTransferState(partial, 'failed', 'interrupted');
    const empty = transfer(dir, 'd.mkv', { complete: false, write: false });
    updateDccTransferState(empty, 'rejected');
    const { markDccFileDeleted } = await import('../db/dccTransfers.js');
    markDccFileDeleted(empty);
    fanOut.mockClear();
    const res = await aliceAgent.post('/api/dcc/clear');
    expect(res.body.ids).toEqual(expect.arrayContaining([done, empty]));
    expect(res.body.ids).not.toContain(active);
    expect(res.body.ids).not.toContain(partial);
    expect(fanOut).toHaveBeenCalledWith(alice.id, {
      kind: 'dcc-transfers-cleared',
      ids: res.body.ids,
    });
    expect(await ids()).toEqual(expect.arrayContaining([active, partial]));
    expect(await ids()).not.toContain(done);
    expect(fs.existsSync(path.join(dir, 'a.mkv'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'c.mkv'))).toBe(true);
    expect((await files()).map((f) => f.name)).toContain('a.mkv');
    // Nothing left to clear: nothing to tell the other tabs.
    fanOut.mockClear();
    expect((await aliceAgent.post('/api/dcc/clear')).body).toEqual({ ids: [] });
    expect(fanOut).not.toHaveBeenCalled();
  });
});
