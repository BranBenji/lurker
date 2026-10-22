// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Adding a friend lets them through caller ID straight away (#1181), through
// a real socket's `favorite-buffer`. Whether they're online, and whether the
// network has caller ID, is the connection's call (callerId.test.ts).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-favoriteaccept');

let server: http.Server;
let userId: number;
let networkId: number;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;
let ircManager: typeof import('./ircManager.js').default;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { ensureExists } = await import('../db/buffers.js');
  ({ createSession } = await import('../db/sessions.js'));
  ircManager = (await import('./ircManager.js')).default;
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('favoriteacceptuser').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'favoriteacceptuser',
  })!.id;
  ensureExists(userId, networkId, 'bob');

  server = http.createServer();
  attachWsHub(server, 'favoriteaccept-test-secret');
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  vi.restoreAllMocks();
  server.close();
  testDb.cleanup();
});

describe('favorite-buffer', () => {
  it('asks the connection to accept the new friend if they’re online', async () => {
    const acceptFriendIfOnline = vi.fn<(nick: string) => void>();
    const { token } = createSession(userId);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no favorites-changed')), 3000);
        let sent = false;
        ws.on('message', (raw) => {
          const f = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (f.kind === 'backlog-complete' && !sent) {
            sent = true;
            // After the snapshot, which reads more of the connection than this.
            vi.spyOn(ircManager, 'getConnection').mockReturnValue({
              acceptFriendIfOnline,
            } as unknown as ReturnType<typeof ircManager.getConnection>);
            ws.send(JSON.stringify({ type: 'favorite-buffer', networkId, target: 'bob' }));
          }
          if (sent && f.kind === 'favorites-changed') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    } finally {
      ws.close();
    }
    expect(acceptFriendIfOnline).toHaveBeenCalledWith('bob');
  });
});
