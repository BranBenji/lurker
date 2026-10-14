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
