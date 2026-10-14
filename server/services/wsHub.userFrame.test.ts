// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A connection's user frames (#1084): a DCC transfer row, already shaped as its
// `dcc-transfer` frame, goes to every one of that user's sockets as it is.
// It used to ride the IRC event bus as a synthetic event wsHub special-cased.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-userframe');

let server: http.Server;
let url: string;
let ircManager: typeof import('./ircManager.js').default;
let createSession: typeof import('../db/sessions.js').createSession;
let alice: number;
let bob: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ createSession } = await import('../db/sessions.js'));
  ircManager = (await import('./ircManager.js')).default;
  const { attachWsHub } = await import('./wsHub.js');
  alice = createUser('userframe-alice').id;
  bob = createUser('userframe-bob').id;

  server = http.createServer();
  attachWsHub(server, 'userframe-test-secret');
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  testDb.cleanup();
});

type Frame = Record<string, unknown>;

// Connect as `userId` and resolve once the opening burst is through, with the
// socket and every frame it hears after that.
async function attach(userId: number): Promise<{ ws: WebSocket; heard: Frame[] }> {
  const { token } = createSession(userId);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const heard: Frame[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no backlog-complete')), 3000);
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Frame;
      if (f.kind === 'backlog-complete') {
        clearTimeout(timer);
        resolve();
      } else heard.push(f);
    });
  });
  heard.length = 0;
  return { ws, heard };
}

describe('user frames', () => {
  it("reach the user's sockets as they are, and no one else's", async () => {
    const a = await attach(alice);
    const b = await attach(bob);
    try {
      const transfer = { id: 7, state: 'receiving', received_bytes: 4096 };
      ircManager.emit('user-frame', alice, { kind: 'dcc-transfer', transfer });
      const deadline = Date.now() + 3000;
      while (!a.heard.some((f) => f.kind === 'dcc-transfer') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(a.heard.filter((f) => f.kind === 'dcc-transfer')).toEqual([
        { kind: 'dcc-transfer', transfer },
      ]);
      expect(b.heard.some((f) => f.kind === 'dcc-transfer')).toBe(false);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
});
