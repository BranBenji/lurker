// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Uploaded avatar tile sets (#607): a zip of images in, a numbered set of
// square WebP tiles out, judged by bytes and sorted by name; per-user; a
// deleted set takes its pointer with it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-avatar-sets');

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let settingsService: typeof import('../services/settingsService.js').default;

async function png(color: string, size = 64): Promise<Buffer> {
  return sharp({ create: { width: size, height: size * 2, channels: 4, background: color } })
    .png()
    .toBuffer();
}

async function zipOf(entries: Record<string, Buffer>): Promise<Buffer> {
  const { ZipArchive } = await import('archiver');
  const archive = new ZipArchive();
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
  await archive.finalize();
  return Buffer.concat(chunks);
}

async function goodZip(): Promise<Buffer> {
  return zipOf({
    'b.png': await png('#00ff00'),
    'a.png': await png('#ff0000'),
    'sub/c.png': await png('#0000ff'),
    'd.png': await png('#ffff00'),
    'notes.txt': Buffer.from('not an image'),
    'fake.png': Buffer.from('still not an image'),
    '__MACOSX/._a.png': Buffer.from('resource fork'),
  });
}

function post(agent: LurkerTestAgent, name: string, zip: Buffer) {
  return agent
    .post('/api/avatar-sets')
    .field('name', name)
    .attach('zip', zip, { filename: 'set.zip', contentType: 'application/zip' });
}

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./avatarSets.js')).default;
  settingsService = (await import('../services/settingsService.js')).default;
  alice = createUser('avatars-alice');
  bob = createUser('avatars-bob');
  app = createTestApp({ '/api/avatar-sets': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

afterAll(() => ctx.cleanup());

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    expect((await createAnonAgent(app).get('/api/avatar-sets')).status).toBe(401);
  });
});

describe('POST /api/avatar-sets', () => {
  it('keeps the images, sorted by name, and says what it skipped', async () => {
    const res = await post(aliceAgent, 'Shapes', await goodZip());
    expect(res.status).toBe(201);
    expect(res.body.set).toMatchObject({ name: 'Shapes', count: 4 });
    expect(res.body.set.bytes).toBeGreaterThan(0);
    expect(res.body.skipped).toEqual([
      { name: 'fake.png', reason: 'not an image' },
      { name: 'notes.txt', reason: 'not an image' },
    ]);
    // Tile 0 is a.png (red), normalised to a 256 square WebP.
    const tile = await aliceAgent.get(`/api/avatar-sets/${res.body.set.id}/000.webp`);
    expect(tile.status).toBe(200);
    expect(tile.headers['content-type']).toBe('image/webp');
    expect(tile.headers['x-content-type-options']).toBe('nosniff');
    expect(tile.headers['cache-control']).toContain('immutable');
    const meta = await sharp(tile.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 256, 256]);
    const { dominant } = await sharp(tile.body as Buffer).stats();
    expect(dominant.r).toBeGreaterThan(200);
    expect(dominant.g).toBeLessThan(60);
    // 1 = b.png (green), 2 = d.png, 3 = sub/c.png (blue): folders sort by path.
    const last = await aliceAgent.get(`/api/avatar-sets/${res.body.set.id}/003.webp`);
    expect((await sharp(last.body as Buffer).stats()).dominant.b).toBeGreaterThan(200);
    expect((await aliceAgent.get(`/api/avatar-sets/${res.body.set.id}/004.webp`)).status).toBe(404);
  });

  it('lists the set for its owner only, and serves its tiles to nobody else', async () => {
    const list = await aliceAgent.get('/api/avatar-sets');
    expect(list.body.items.map((s: { name: string }) => s.name)).toEqual(['Shapes']);
    expect((await bobAgent.get('/api/avatar-sets')).body.items).toEqual([]);
    const id = list.body.items[0].id;
    expect((await bobAgent.get(`/api/avatar-sets/${id}/000.webp`)).status).toBe(404);
    expect((await bobAgent.delete(`/api/avatar-sets/${id}`)).status).toBe(404);
  });

  it('refuses a set with too few usable images, naming the skipped ones', async () => {
    const res = await post(
      aliceAgent,
      'Thin',
      await zipOf({ 'a.png': await png('#ff0000'), 'b.txt': Buffer.from('x') }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at least 4 usable images, found 1');
    expect(res.body.error).toContain('b.txt: not an image');
  });

  it('refuses a bad name, a taken name, and something that is not a zip', async () => {
    const zip = await goodZip();
    expect((await post(aliceAgent, 'default', zip)).body.error).toBe('"default" is reserved');
    expect((await post(aliceAgent, 'shapes', zip)).body.error).toBe(
      'a set named "Shapes" already exists',
    );
    expect((await post(aliceAgent, '', zip)).body.error).toBe('name is required');
    const notZip = await post(aliceAgent, 'Nope', Buffer.from('definitely not a zip'));
    expect(notZip.status).toBe(400);
    expect(notZip.body.error).toBe('not a zip file');
    const noFile = await aliceAgent.post('/api/avatar-sets').field('name', 'Nope');
    expect(noFile.status).toBe(400);
  });

  it('skips an animated image rather than freezing its first frame', async () => {
    // Two frames, red then blue, as one GIF.
    const frame = (color: string) =>
      sharp({ create: { width: 8, height: 8, channels: 4, background: color } })
        .raw()
        .toBuffer();
    const gif = await sharp(Buffer.concat([await frame('#ff0000'), await frame('#0000ff')]), {
      raw: { width: 8, height: 16, channels: 4, pageHeight: 8 },
    })
      .gif()
      .toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
    const res = await post(
      aliceAgent,
      'Moving',
      await zipOf({
        'a.gif': gif,
        'b.png': await png('#111111'),
        'c.png': await png('#222222'),
        'd.png': await png('#333333'),
        'e.png': await png('#444444'),
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.set.count).toBe(4);
    expect(res.body.skipped).toEqual([{ name: 'a.gif', reason: 'animated' }]);
  });
});

describe('DELETE /api/avatar-sets/:id', () => {
  it('removes the set and resets a look.avatars.set pointer aimed at it', async () => {
    const created = await post(aliceAgent, 'Pointed', await goodZip());
    const id = created.body.set.id;
    settingsService.update(alice.id, { 'look.avatars.set': String(id) });
    const before = settingsService.update(alice.id, {});
    expect(before.ok && before.values['look.avatars.set']).toBe(String(id));
    const res = await aliceAgent.delete(`/api/avatar-sets/${id}`);
    expect(res.status).toBe(200);
    const after = settingsService.update(alice.id, {});
    expect(after.ok && after.values['look.avatars.set']).toBeUndefined();
    expect((await aliceAgent.get(`/api/avatar-sets/${id}/000.webp`)).status).toBe(404);
    expect((await aliceAgent.delete(`/api/avatar-sets/${id}`)).status).toBe(404);
    expect((await aliceAgent.delete('/api/avatar-sets/zero')).status).toBe(400);
  });
});
