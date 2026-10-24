// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Metadata avatars through the decoder (lurker#1190): the cell asks for the image resized,
// keeps it in the byte cache under its own key, and serves it with the media headers. A
// decoder too old to have /avatar answers 404, and the cell relays the origin's bytes as it
// did before, so updating the cell first breaks nothing.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import { startStubDecoder, type StubDecoder } from '../test-utils/stubDecoder.js';

const ctx = setupTestDb('routes-link-preview-avatar');
process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
process.env.LURKER_PREVIEW_CACHE_DIR = path.join(ctx.tmpDir, 'avatar-cache');

let stub: StubDecoder;
let agent: LurkerTestAgent;
let origin: http.Server;
let base: string;
let png: Buffer;
let webp: Buffer;
let avatarClientUrl: typeof import('../services/avatarProxy.js').avatarClientUrl;
let mintProxyToken: typeof import('../services/mediaProxyToken.js').mintProxyToken;
let whenStoresSettle: typeof import('../services/previewCache/index.js').whenStoresSettle;
let countCached: typeof import('../db/previewCache.js').countCached;

beforeAll(async () => {
  stub = await startStubDecoder();
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#a42' } })
    .png()
    .toBuffer();
  webp = await sharp(png).resize(30, 30).webp().toBuffer();
  origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
    res.end(png);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

  const { createUser } = await import('../db/users.js');
  ({ avatarClientUrl } = await import('../services/avatarProxy.js'));
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  ({ whenStoresSettle } = await import('../services/previewCache/index.js'));
  ({ countCached } = await import('../db/previewCache.js'));
  const router = (await import('./linkPreview.js')).default;
  const app: Express = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, createUser('alice-avatar').id);
});

afterAll(async () => {
  await stub.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  delete process.env.LURKER_PREVIEW_CACHE_MODE;
  delete process.env.LURKER_PREVIEW_CACHE_DIR;
  ctx.cleanup();
});

beforeEach(async () => {
  // A relay's store from the test before still settling would land in this one's count.
  await whenStoresSettle();
  stub.avatarAsks.length = 0;
  stub.fetchAsks.length = 0;
  stub.onAvatar = null;
});

const answer =
  (status: number, body?: Buffer, headers: Record<string, string> = {}) =>
  (_url: string, res: http.ServerResponse) =>
    res.writeHead(status, headers).end(body);

describe('GET /api/link-preview/avatar/:token', () => {
  it("serves the decoder's avatar, then the cached one without asking again", async () => {
    stub.onAvatar = answer(200, webp, { 'content-type': 'image/webp' });
    const url = avatarClientUrl(`${base}/me.png`)!;
    expect(url).toMatch(/^\/api\/link-preview\/avatar\/.+\..+$/);

    const first = await agent.get(url).expect(200);
    expect(first.headers['content-type']).toBe('image/webp');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(first.body).equals(webp)).toBe(true);
    expect(stub.avatarAsks).toEqual([`${base}/me.png`]);

    await whenStoresSettle();
    const second = await agent.get(url).expect(200);
    expect(Buffer.from(second.body).equals(webp)).toBe(true);
    expect(stub.avatarAsks).toHaveLength(1);
  });

  it("relays the origin's bytes through a decoder without /avatar", async () => {
    const url = avatarClientUrl(`${base}/old-decoder.png`)!;
    const res = await agent.get(url).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.body).equals(png)).toBe(true);
    expect(stub.avatarAsks).toEqual([`${base}/old-decoder.png`]);
    expect(stub.fetchAsks.map((a) => a.url)).toEqual([`${base}/old-decoder.png`]);
  });

  it('is a 404, and keeps nothing, when the decoder has no avatar for it', async () => {
    const before = countCached();
    stub.onAvatar = answer(415);
    await agent.get(avatarClientUrl(`${base}/not-an-image`)!).expect(404);
    await whenStoresSettle();
    expect(countCached()).toBe(before);
    expect(stub.fetchAsks).toEqual([]);
  });

  it("is a 404 for a 'WebP' whose bytes say otherwise, and keeps nothing", async () => {
    const before = countCached();
    stub.onAvatar = answer(200, Buffer.from('<svg onload=alert(1)>'), {
      'content-type': 'image/webp',
    });
    await agent.get(avatarClientUrl(`${base}/liar.png`)!).expect(404);
    await whenStoresSettle();
    expect(countCached()).toBe(before);
  });

  it('stays transient when the decoder says to back off', async () => {
    stub.onAvatar = answer(503, undefined, { 'retry-after': '9' });
    const res = await agent.get(avatarClientUrl(`${base}/busy.png`)!).expect(503);
    expect(res.headers['retry-after']).toBe('9');
  });

  it('asks the decoder once for viewers who arrive together', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    stub.onAvatar = (_url, res) => {
      void held.then(() => res.writeHead(200, { 'content-type': 'image/webp' }).end(webp));
    };
    const url = avatarClientUrl(`${base}/popular.png`)!;
    const both = Promise.all([agent.get(url), agent.get(url)]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await both;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(stub.avatarAsks).toEqual([`${base}/popular.png`]);
  });

  it('keeps nothing the origin said not to keep, and asks again next time', async () => {
    stub.onAvatar = answer(200, webp, {
      'content-type': 'image/webp',
      'cache-control': 'no-store',
    });
    const url = avatarClientUrl(`${base}/private.png`)!;
    await agent.get(url).expect(200);
    await whenStoresSettle();
    await agent.get(url).expect(200);
    expect(stub.avatarAsks).toHaveLength(2);
  });

  it('is a 404 for an answer too big to be an avatar, or a status it does not know', async () => {
    const huge = Buffer.concat([webp.subarray(0, 16), Buffer.alloc(1024 * 1024)]);
    stub.onAvatar = answer(200, huge, { 'content-type': 'image/webp' });
    expect((await agent.get(avatarClientUrl(`${base}/huge.png`)!)).status).toBe(404);
    // Small, but a full-size canvas: what a skewed or compromised decoder could send.
    const wide = await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: '#000' },
    })
      .webp()
      .toBuffer();
    stub.onAvatar = answer(200, wide, { 'content-type': 'image/webp' });
    expect((await agent.get(avatarClientUrl(`${base}/wide.png`)!)).status).toBe(404);
    stub.onAvatar = answer(500);
    expect((await agent.get(avatarClientUrl(`${base}/crashed.png`)!)).status).toBe(404);
  });

  it('stays transient when the decoder hop itself fails', async () => {
    stub.onAvatar = (_url, res) => res.socket?.destroy();
    const res = await agent.get(avatarClientUrl(`${base}/hop.png`)!).expect(503);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('refuses an avatar token on the media route, without asking the decoder', async () => {
    const token = String(avatarClientUrl(`${base}/me.png`))
      .split('/')
      .at(-1);
    await agent.get(`/api/link-preview/media/${token}`).expect(403);
    expect(stub.fetchAsks).toEqual([]);
  });

  it('serves only what it minted: a media token is a 403 here', async () => {
    const media = await agent.get(`/api/link-preview/avatar/${mintProxyToken(`${base}/me.png`)}`);
    expect(media.status).toBe(403);
    expect((await agent.get('/api/link-preview/avatar/forged.sig')).status).toBe(403);
    expect(stub.avatarAsks).toEqual([]);
  });
});
