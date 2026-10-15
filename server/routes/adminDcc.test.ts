// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-admin-dcc');

let app: Express;
let adminAgent: LurkerTestAgent;
let userAgent: LurkerTestAgent;
let user: User;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./admin.js')).default;
  const admin = createUser('dcc-admin', { role: 'admin' });
  user = createUser('dcc-member', { role: 'user' });
  app = createTestApp({ '/api/admin': router });
  adminAgent = await createAuthedAgent(app, admin.id);
  userAgent = await createAuthedAgent(app, user.id);
});

afterAll(() => ctx.cleanup());

afterEach(() => {
  delete process.env.LURKER_DCC_ENABLED;
  delete process.env.LURKER_DCC_DIR;
});

type Row = { id: number; chat: boolean; receive: boolean };
const rowFor = async (id: number): Promise<Row> =>
  (await adminAgent.get('/api/admin/dcc')).body.users.find((u: Row) => u.id === id);

// Before #1080 granting DCC took an SQL write, and it was one switch. Now it is
// two, so an admin can allow chats without letting files land on the box.
describe('/api/admin/dcc', () => {
  it('reports the instance settings', async () => {
    process.env.LURKER_DCC_ENABLED = '1';
    process.env.LURKER_DCC_DIR = '/srv/dcc';
    const res = await adminAgent.get('/api/admin/dcc');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      directory: '/srv/dcc',
      maxFileBytes: 0,
      allowPrivateHosts: false,
      freeDiskFloorBytes: 1024 * 1024 * 1024,
    });
  });

  it('grants chat and receive separately', async () => {
    const { createUser } = await import('../db/users.js');
    const target = createUser('dcc-split');
    const url = `/api/admin/dcc/users/${target.id}`;
    expect(await rowFor(target.id)).toMatchObject({ chat: false, receive: false });

    const chatOnly = await adminAgent.put(url).send({ chat: true });
    expect(chatOnly.status).toBe(200);
    expect(chatOnly.body).toEqual({ chat: true, receive: false, send: false, limitBytes: null });
    expect(await rowFor(target.id)).toMatchObject({ chat: true, receive: false });

    await adminAgent.put(url).send({ receive: true });
    expect(await rowFor(target.id)).toMatchObject({ chat: true, receive: true });

    await adminAgent.put(url).send({ chat: false, receive: false });
    expect(await rowFor(target.id)).toMatchObject({ chat: false, receive: false });
  });

  // #1086: sending opens a port to a peer, so it is a grant of its own.
  it('grants sending apart from receiving', async () => {
    const { createUser } = await import('../db/users.js');
    const target = createUser('dcc-sender');
    const url = `/api/admin/dcc/users/${target.id}`;
    const res = await adminAgent.put(url).send({ send: true });
    expect(res.body).toMatchObject({ chat: false, receive: false, send: true });
    expect(await rowFor(target.id)).toMatchObject({ receive: false, send: true });
    expect((await adminAgent.put(url).send({ send: 'yes' })).status).toBe(400);
  });

  // With the instance switch off a grant does nothing, but it still lists, so
  // an admin can clear it before turning DCC back on.
  it('lists and changes grants while the instance switch is off', async () => {
    const { createUser } = await import('../db/users.js');
    const target = createUser('dcc-while-off');
    const res = await adminAgent.put(`/api/admin/dcc/users/${target.id}`).send({ chat: true });
    expect(res.status).toBe(200);
    const list = await adminAgent.get('/api/admin/dcc');
    expect(list.body.enabled).toBe(false);
    expect(list.body.users.find((u: Row) => u.id === target.id).chat).toBe(true);
  });

  // #1125: the admin's per-user space control. A whole number of bytes, or
  // null for none; the list reports it with what the account uses now.
  it('sets and clears a storage limit, and reports usage', async () => {
    const { createUser } = await import('../db/users.js');
    const { createNetwork } = await import('../db/networks.js');
    const { insertDccTransfer, markDccReceiving, markDccCompleted } =
      await import('../db/dccTransfers.js');
    const target = createUser('dcc-limited');
    const net = createNetwork(target.id, {
      name: 'n',
      host: 'irc.example',
      port: 6697,
      tls: true,
      nick: 'x',
    })!;
    const id = insertDccTransfer(target.id, {
      network_id: net.id,
      peer_nick: 'bot',
      filename: 'a.bin',
      advertised_size: 1500,
      state: 'pending_approval',
    });
    markDccReceiving(id, {
      filename: 'a.bin',
      advertised_size: 1500,
      destination_path: '/srv/dcc/dcc-limited/a.bin',
      received_bytes: 1500,
    });
    markDccCompleted(id, 1500);
    const url = `/api/admin/dcc/users/${target.id}`;
    const set = await adminAgent.put(url).send({ limitBytes: 50 * 1024 ** 3 });
    expect(set.status).toBe(200);
    expect(set.body.limitBytes).toBe(50 * 1024 ** 3);
    const row = (await adminAgent.get('/api/admin/dcc')).body.users.find(
      (u: { id: number }) => u.id === target.id,
    );
    expect(row).toMatchObject({ limitBytes: 50 * 1024 ** 3, usedBytes: 1500 });
    expect((await adminAgent.put(url).send({ limitBytes: null })).body.limitBytes).toBeNull();
    for (const bad of [0, -5, 1.5, '10', true]) {
      expect((await adminAgent.put(url).send({ limitBytes: bad })).status).toBe(400);
    }
  });

  it('400s a body with no part or a non-boolean, 404s an unknown id', async () => {
    const url = `/api/admin/dcc/users/${user.id}`;
    expect((await adminAgent.put(url).send({})).status).toBe(400);
    expect((await adminAgent.put(url).send({ chat: 'yes' })).status).toBe(400);
    expect((await adminAgent.put(url).send({ receive: 1 })).status).toBe(400);
    expect((await adminAgent.put('/api/admin/dcc/users/abc').send({ chat: true })).status).toBe(
      400,
    );
    expect((await adminAgent.put('/api/admin/dcc/users/999999').send({ chat: true })).status).toBe(
      404,
    );
  });

  it('requires admin — a member cannot read grants or grant themselves', async () => {
    expect((await userAgent.get('/api/admin/dcc')).status).toBe(403);
    const res = await userAgent.put(`/api/admin/dcc/users/${user.id}`).send({ receive: true });
    expect(res.status).toBe(403);
  });
});
