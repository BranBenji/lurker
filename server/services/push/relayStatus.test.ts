// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The relay status check (lurker-dev/RELAY_PLAN.md §6.5). fetch is stubbed:
// nothing here may reach the real push.lurker.chat.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { setupTestDb } from '../../test-utils/testApp.js';

const ctx = setupTestDb('services-push-relay-status');

let mod: typeof import('./relayStatus.js');
let pushService: typeof import('../pushService.js');
let RELAY_ORIGIN: string;

beforeAll(async () => {
  mod = await import('./relayStatus.js');
  pushService = await import('../pushService.js');
  ({ RELAY_ORIGIN } = await import('./relayOrigin.js'));
});

afterAll(() => ctx.cleanup());

beforeEach(() => mod.resetRelayStatusCache());
afterEach(() => vi.unstubAllGlobals());

type FetchArgs = [url: string, init: RequestInit];
function stubRelay(answer: (url: string, init: RequestInit) => Promise<Response>) {
  const fetch = vi.fn<(...args: FetchArgs) => Promise<Response>>(answer);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('relayStatus', () => {
  it('reads an active, paid key', async () => {
    stubRelay(() =>
      json(200, {
        registered: true,
        active: true,
        comped: false,
        paidThrough: '2027-10-06T00:00:00Z',
      }),
    );
    expect(await mod.relayStatus()).toEqual({
      state: 'active',
      comped: false,
      paidThrough: '2027-10-06T00:00:00Z',
    });
  });

  it('reads a comped key', async () => {
    stubRelay(() => json(200, { registered: true, active: true, comped: true, paidThrough: null }));
    expect(await mod.relayStatus()).toEqual({ state: 'active', comped: true, paidThrough: null });
  });

  it('tells an unknown key from a lapsed one', async () => {
    stubRelay(() =>
      json(200, { registered: false, active: false, comped: false, paidThrough: null }),
    );
    expect(await mod.relayStatus()).toEqual({ state: 'inactive', registered: false });
    mod.resetRelayStatusCache();
    stubRelay(() =>
      json(200, { registered: true, active: false, comped: false, paidThrough: null }),
    );
    expect(await mod.relayStatus()).toEqual({ state: 'inactive', registered: true });
  });

  it('reads a 401 as the relay refusing our signature', async () => {
    stubRelay(() => json(401, { error: 'bad signature' }));
    expect(await mod.relayStatus()).toEqual({ state: 'unauthorized' });
  });

  it('reads a 5xx, garbage, and a network error as unreachable', async () => {
    stubRelay(() => json(503, {}));
    expect((await mod.relayStatus({ fresh: true })).state).toBe('unreachable');
    stubRelay(() => Promise.resolve(new Response('<html>', { status: 200 })));
    expect((await mod.relayStatus({ fresh: true })).state).toBe('unreachable');
    stubRelay(() => json(200, { hello: 'world' }));
    expect((await mod.relayStatus({ fresh: true })).state).toBe('unreachable');
    stubRelay(() => Promise.reject(new TypeError('fetch failed')));
    expect((await mod.relayStatus({ fresh: true })).state).toBe('unreachable');
  });

  it('gives up after the timeout', async () => {
    stubRelay(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const status = await mod.relayStatus({ fresh: true, timeoutMs: 20 });
    expect(status.state).toBe('unreachable');
  });

  it('caches for a minute unless asked fresh', async () => {
    const fetch = stubRelay(() =>
      json(200, { registered: true, active: true, comped: true, paidThrough: null }),
    );
    await mod.relayStatus({ now: 1_000 });
    await mod.relayStatus({ now: 30_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await mod.relayStatus({ now: 30_000, fresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    await mod.relayStatus({ now: 100_000 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("asks {relay}/status, signed with this server's VAPID key for the relay's origin", async () => {
    const fetch = stubRelay(() =>
      json(200, { registered: true, active: true, comped: true, paidThrough: null }),
    );
    await mod.relayStatus({ fresh: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${RELAY_ORIGIN}/status`);

    const auth = new Headers(init.headers).get('authorization')!;
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
    expect(m).not.toBeNull();
    const [, jwt, k] = m!;
    const { publicKey } = pushService.vapidCredentials();
    expect(k).toBe(publicKey);

    const [h, p, sig] = jwt.split('.');
    const point = Buffer.from(publicKey, 'base64url');
    const key = crypto.createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.aud).toBe(RELAY_ORIGIN);
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  });
});
