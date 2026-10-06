// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// LURKER_PUSH_RELAY_URL is read once at import, so each case imports the
// module fresh with the variable set.

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { setupTestDb } from '../../test-utils/testApp.js';

const ctx = setupTestDb('services-push-relay');

async function importWith(url: string) {
  vi.resetModules();
  process.env.LURKER_PUSH_RELAY_URL = url;
  return import('./relay.js');
}

afterEach(() => {
  delete process.env.LURKER_PUSH_RELAY_URL;
});

afterAll(() => ctx.cleanup());

describe('LURKER_PUSH_RELAY_URL', () => {
  it('advertises the override, and still covers the official relay', async () => {
    const relay = await importWith('https://relay-dev.example.test');
    expect(relay.RELAY_ORIGIN).toBe('https://relay-dev.example.test');
    expect(relay.isRelayEndpoint('https://relay-dev.example.test/relay-to/fcm/x')).toBe(true);
    // Rows filed under the official relay before the override was set.
    expect(relay.isRelayEndpoint('https://push.lurker.chat/relay-to/fcm/x')).toBe(true);
    expect(relay.isRelayEndpoint('https://example.test/x')).toBe(false);
  });

  it('must be https, since web-push sends everything over https', async () => {
    await expect(importWith('http://localhost:8787')).rejects.toThrow(/must be https/);
  });
});
