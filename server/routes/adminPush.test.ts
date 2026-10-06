// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The push relay opt-in (lurker-dev/RELAY_PLAN.md §5a), end to end: the admin
// switch, what /api/push/config tells the apps, and the registration route
// enforcing it. One suite because the promise spans all three — while the relay
// is off, nothing on this server points at it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-admin-push');

const RELAY = 'https://push.lurker.chat';

let app: Express;
let adminAgent: LurkerTestAgent;
let userAgent: LurkerTestAgent;
let admin: User;
let plainUser: User;
let db: typeof import('../db/index.js').default;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const adminRouter = (await import('./admin.js')).default;
  const pushRouter = (await import('./push.js')).default;
  db = (await import('../db/index.js')).default;

  admin = createUser('adminpush-root', { role: 'admin' });
  plainUser = createUser('adminpush-user');

  app = createTestApp({ '/api/admin': adminRouter, '/api/push': pushRouter });
  adminAgent = await createAuthedAgent(app, admin.id);
  userAgent = await createAuthedAgent(app, plainUser.id);
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  db.prepare('DELETE FROM push_subscriptions').run();
  db.prepare(`DELETE FROM instance_settings WHERE key = 'push.relay_enabled'`).run();
});

const subscribe = (agent: LurkerTestAgent, endpoint: string) =>
  agent.post('/api/push/subscriptions').send({
    endpoint,
    keys: { p256dh: 'p256-key', auth: 'auth-key' },
  });

const setRelay = (enabled: unknown) => adminAgent.put('/api/admin/push/relay').send({ enabled });

describe('GET /api/admin/push', () => {
  it('is admin-only', async () => {
    const res = await userAgent.get('/api/admin/push');
    expect(res.status).toBe(403);
  });

  it('shows the VAPID key the admin registers, with the relay off by default', async () => {
    const res = await adminAgent.get('/api/admin/push');
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(20);
    expect(res.body.relay).toEqual({ url: RELAY, enabled: false, devices: 0 });
  });

  it('is the same key /api/push/config hands out', async () => {
    const adminRes = await adminAgent.get('/api/admin/push');
    const configRes = await userAgent.get('/api/push/config');
    expect(adminRes.body.publicKey).toBe(configRes.body.publicKey);
  });
});

describe('PUT /api/admin/push/relay', () => {
  it('is admin-only', async () => {
    const res = await userAgent.put('/api/admin/push/relay').send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('wants a boolean', async () => {
    expect((await setRelay('yes')).status).toBe(400);
    expect((await setRelay(undefined)).status).toBe(400);
  });

  it('turns the relay on', async () => {
    const res = await setRelay(true);
    expect(res.status).toBe(200);
    expect(res.body.relay.enabled).toBe(true);
    expect(res.body.removed).toBe(0);
  });
});

describe('/api/push/config', () => {
  it('never mentions the relay while it is off', async () => {
    const res = await userAgent.get('/api/push/config');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('relay');
  });

  it('names the relay once the admin turns it on', async () => {
    await setRelay(true);
    const res = await userAgent.get('/api/push/config');
    expect(res.body.relay).toBe(RELAY);
  });

  it('stops naming it when turned back off', async () => {
    await setRelay(true);
    await setRelay(false);
    const res = await userAgent.get('/api/push/config');
    expect(res.body).not.toHaveProperty('relay');
  });
});

describe('registering a relay endpoint', () => {
  it('is refused while the relay is off', async () => {
    const res = await subscribe(userAgent, `${RELAY}/relay-to/apns/production/abc`);
    expect(res.status).toBe(403);
    const count = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('is matched on origin, not spelling', async () => {
    const res = await subscribe(userAgent, 'https://PUSH.lurker.chat:443/relay-to/fcm/abc');
    expect(res.status).toBe(403);
  });

  it('is matched with a trailing-dot host too', async () => {
    // Same host to DNS and TLS, but a different URL.origin.
    for (const endpoint of [
      'https://push.lurker.chat./relay-to/apns/production/x',
      'https://push.lurker.chat%2E/relay-to/apns/production/x',
    ]) {
      expect((await subscribe(userAgent, endpoint)).status).toBe(403);
    }
  });

  it('is accepted once the relay is on, and counted for the admin', async () => {
    await setRelay(true);
    const res = await subscribe(userAgent, `${RELAY}/relay-to/apns/production/abc`);
    expect(res.status).toBe(201);
    const admin = await adminAgent.get('/api/admin/push');
    expect(admin.body.relay.devices).toBe(1);
  });

  it('leaves browsers alone either way', async () => {
    const res = await subscribe(userAgent, 'https://fcm.googleapis.com/fcm/send/browser');
    expect(res.status).toBe(201);
  });

  it('only matches the relay host itself', async () => {
    const res = await subscribe(userAgent, 'https://push.lurker.chat.example.com/x');
    expect(res.status).toBe(201);
  });
});

describe('the device count', () => {
  it('leaves out relay rows disabled after repeated failures', async () => {
    await setRelay(true);
    await subscribe(userAgent, `${RELAY}/relay-to/apns/production/live`);
    await subscribe(userAgent, `${RELAY}/relay-to/apns/production/dead`);
    db.prepare(`UPDATE push_subscriptions SET enabled = 0 WHERE endpoint LIKE '%/dead'`).run();
    const res = await adminAgent.get('/api/admin/push');
    expect(res.body.relay.devices).toBe(1);
  });
});

describe('turning the relay off', () => {
  it("deletes every user's relay devices and keeps their browsers", async () => {
    await setRelay(true);
    await subscribe(userAgent, `${RELAY}/relay-to/apns/production/user`);
    await subscribe(adminAgent, `${RELAY}/relay-to/fcm/admin`);
    await subscribe(userAgent, 'https://updates.push.services.mozilla.com/wpush/v2/x');

    const res = await setRelay(false);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);
    expect(res.body.relay.devices).toBe(0);

    const left = db.prepare('SELECT endpoint FROM push_subscriptions').all() as {
      endpoint: string;
    }[];
    expect(left.map((r) => r.endpoint)).toEqual([
      'https://updates.push.services.mozilla.com/wpush/v2/x',
    ]);
  });
});
