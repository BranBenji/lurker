// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

// Deleting a hosted upload (node edition, control-plane #55): the cell asks the
// control plane, which holds the delete key. Edition caches on first read, and
// vitest gives this file its own process.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_UPLOAD_URL = 'https://dropper.test';
process.env.LURKER_NODE_UPLOAD_API_KEY = 'operator-key-123';
process.env.LURKER_NODE_NAME = 'cell-7';
process.env.LURKER_NODE_SECRET = 'fleet-secret';

const ctx = setupTestDb('routes-uploads-hosted-delete');

// A stand-in control plane: the owner-delete endpoint answers whatever the test
// sets, and the report endpoint records what it's sent.
type Answer = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };
let deleteAnswers: Answer[] = [];
const deleteCalls: { auth?: string; body: Record<string, unknown> }[] = [];
const reports: Record<string, unknown>[] = [];
let cp: http.Server;

function startFakeCp(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/_cp/moderation/uploads/delete', (req, res) => {
    deleteCalls.push({ auth: req.headers.authorization, body: req.body });
    const a = deleteAnswers.shift() ?? { status: 200, body: { ok: true, cdn_purged: true } };
    for (const [k, v] of Object.entries(a.headers ?? {})) res.set(k, v);
    res.status(a.status).json(a.body);
  });
  app.post('/_cp/moderation/uploads', (req, res) => {
    reports.push(req.body);
    res.json({ ok: true });
  });
  return new Promise((resolve) => {
    cp = app.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(cp.address() as AddressInfo).port}`),
    );
  });
}

let app: Express;
let agent: LurkerTestAgent;
let userId: number;
let otherUserId: number;
let history: typeof import('../db/uploadHistory.js');

beforeAll(async () => {
  process.env.LURKER_ORCHESTRATOR_URL = await startFakeCp();
  const { createUser } = await import('../db/users.js');
  history = await import('../db/uploadHistory.js');
  const router = (await import('./uploads.js')).default;
  userId = createUser('hosted-delete-alice').id;
  otherUserId = createUser('hosted-delete-bob').id;
  app = createTestApp({ '/api/uploads': router });
  agent = await createAuthedAgent(app, userId);
});

afterAll(() => {
  cp.close();
  ctx.cleanup();
});

beforeEach(() => {
  deleteAnswers = [];
  deleteCalls.length = 0;
  reports.length = 0;
});

let n = 0;
// A hosted upload as the dropper leaves one: a CDN URL and thumbnail, no ref.
function hostedUpload(owner = userId): number {
  n += 1;
  return history.insertUpload(owner, {
    provider: 'dropper',
    url: `https://cdn.test/f${n}.png`,
    mime: 'image/png',
    byte_size: 100,
    width: 16,
    height: 16,
    thumbnail: null,
    thumbnail_url: `https://cdn.test/thumbs/f${n}.png`,
  });
}

const exists = (id: number) => history.getUploadForReap(userId, id) !== undefined;

describe('hosted upload delete (node edition, control-plane #55)', () => {
  it('offers delete on hosted rows, though the dropper captured no delete handle', async () => {
    const id = hostedUpload();
    const res = await agent.get('/api/uploads');
    expect(res.status).toBe(200);
    expect(res.body.items.find((i: { id: number }) => i.id === id).can_delete).toBe(true);
  });

  it('asks the control plane, then drops the row once it says the bytes are gone', async () => {
    const id = hostedUpload();
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(200);
    expect(deleteCalls).toEqual([
      {
        auth: 'Bearer fleet-secret',
        body: { cell: 'cell-7', cell_user_id: userId, cell_upload_id: id },
      },
    ]);
    expect(exists(id)).toBe(false);
  });

  it('reports an upload the control plane has not indexed yet, then asks again', async () => {
    const id = hostedUpload();
    deleteAnswers = [
      { status: 404, body: { code: 'not_indexed', error: 'upload not indexed yet' } },
    ];
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(200);
    expect(reports).toEqual([
      expect.objectContaining({
        cell: 'cell-7',
        cell_upload_id: id,
        cell_user_id: userId,
        url: `https://cdn.test/f${n}.png`,
        thumb_url: `https://cdn.test/thumbs/f${n}.png`,
      }),
    ]);
    expect(deleteCalls).toHaveLength(2);
    expect(exists(id)).toBe(false);
  });

  it.each([
    [{ status: 409, body: { code: 'taken_down' } }, 409, /removed by moderation/],
    [{ status: 502, body: { code: 'storage_unavailable' } }, 502, /try again/],
    [{ status: 403, body: { code: 'not_from_cell' } }, 502, /could not delete/],
    [{ status: 503, body: { code: 'storage_unconfigured' } }, 503, /could not delete/],
  ])('keeps the row when the control plane refuses (%j → %i)', async (answer, status, message) => {
    const id = hostedUpload();
    deleteAnswers = [answer];
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(status);
    expect(res.body.error).toMatch(message);
    expect(exists(id)).toBe(true);
  });

  it('passes a rate limit on, with its Retry-After', async () => {
    const id = hostedUpload();
    deleteAnswers = [
      { status: 429, body: { code: 'rate_limited' }, headers: { 'Retry-After': '17' } },
    ];
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('17');
    expect(exists(id)).toBe(true);
  });

  it('keeps the row when the control plane cannot be reached', async () => {
    const id = hostedUpload();
    const saved = process.env.LURKER_ORCHESTRATOR_URL;
    process.env.LURKER_ORCHESTRATOR_URL = 'http://127.0.0.1:9'; // nothing listens on discard
    try {
      const res = await agent.delete(`/api/uploads/${id}`);
      expect(res.status).toBe(502);
    } finally {
      process.env.LURKER_ORCHESTRATOR_URL = saved;
    }
    expect(exists(id)).toBe(true);
  });

  it("never asks about another user's upload, or one taken down", async () => {
    const theirs = hostedUpload(otherUserId);
    expect((await agent.delete(`/api/uploads/${theirs}`)).status).toBe(404);

    const removed = hostedUpload();
    history.markUploadRemovedById(removed);
    expect((await agent.delete(`/api/uploads/${removed}`)).status).toBe(409);
    expect(deleteCalls).toEqual([]);
  });
});
