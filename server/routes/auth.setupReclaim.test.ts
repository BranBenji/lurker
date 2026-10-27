// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// An abandoned passkey setup used to brick the instance: /setup/options creates
// the admin before the ceremony, nothing deleted it when the ceremony never
// finished, and every later setup call answered 409 with no credential to sign
// in with. A lone admin with no passkey and no password is setup still pending.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { setupTestDb, createTestApp, testRequest } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-auth-setup-reclaim');

let app: Express;
let users: typeof import('../db/users.js');

beforeAll(async () => {
  const router = (await import('./auth.js')).default;
  users = await import('../db/users.js');
  app = createTestApp({ '/api/auth': router });
});

afterAll(() => ctx.cleanup());

describe('abandoned first-run setup', () => {
  it('still reports needsSetup and lets a new setup replace the stranded admin', async () => {
    // Exactly what /setup/options leaves behind when the ceremony is abandoned.
    const stranded = users.createUser('stranded', { role: 'admin' });
    expect(users.countUsers()).toBe(1);

    const status = await testRequest(app).get('/api/auth/setup-status');
    expect(status.body.needsSetup).toBe(true);

    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: 'operator',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
    expect(users.findUserById(stranded.id)).toBeUndefined();
    expect(users.countUsers()).toBe(1);
  });

  it('an admin with a password is a finished setup, not an abandoned one', async () => {
    const status = await testRequest(app).get('/api/auth/setup-status');
    expect(status.body.needsSetup).toBe(false);
    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: 'intruder',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(409);
    expect(users.countUsers()).toBe(1);
  });

  it('a live setup challenge means in progress, not abandoned', async () => {
    const { id } = users.listUsers()[0];
    users.setPasswordHash(id, null);
    const { saveChallenge, consumeChallenge } = await import('../services/webauthn.js');
    const token = saveChallenge({ purpose: 'setup', challenge: 'c', userId: id });
    const status = await testRequest(app).get('/api/auth/setup-status');
    expect(status.body.needsSetup).toBe(false);
    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: 'racer',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in progress/);
    expect(users.findUserById(id)).toBeDefined();
    consumeChallenge(token);
    expect((await testRequest(app).get('/api/auth/setup-status')).body.needsSetup).toBe(true);
    users.setPasswordHash(id, 'x');
  });

  it('a validation failure never deletes the stranded admin', async () => {
    const { id } = users.listUsers()[0];
    users.setPasswordHash(id, null);
    // Now stranded again — but a bad request must leave it for a good one.
    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: 'operator2',
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(users.findUserById(id)).toBeDefined();
  });
});
