// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Metadata after an engine re-attach (#607). The held socket kept its
// subscriptions, so the SUB the replayed 001 draws adds nothing and ergo
// answers it with no 774 — the new process would hold nothing until someone
// changed something. The restore asks for everything outright.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { rawClient } from '../test-utils/fakeIrcd.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';

const SECRET = 'metadata-restore-secret';

let harness: EngineHarness;
let ircd: FakeIrcd;
let userId: number;
let network: Network;
const until = (pred: () => boolean, ms: number, what: string) => harness.until(pred, ms, what);

beforeAll(async () => {
  harness = await startEngineHarness({ secret: SECRET, ircd: { metadata: true } });
  ircd = harness.ircd;
  const user = createUser('metadata-restore');
  userId = user.id;
  network = createNetwork(user.id, {
    name: 'metadata-restore',
    host: '127.0.0.1',
    port: ircd.port,
    tls: 0,
    nick: 'mrestore',
    autoconnect: 0,
  })!;
});

afterAll(async () => {
  await harness.stop();
});

describe('engine re-attach', () => {
  it('syncs every channel and itself, since a repeated SUB brings nothing', async () => {
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    conn.join('#kept');
    await until(() => conn.isChannelJoined('#kept'), 5000, 'joined');
    const peer = await rawClient(ircd.port, 'keptpeer');
    try {
      peer.send('JOIN #kept');
      await until(() => conn.channelState('#kept')?.members.has('keptpeer') ?? false, 5000, 'in');
      ircd.setMetadata('keptpeer', 'display-name', 'Kept Peer');
      await until(
        () => conn.userMetadataRecord('keptpeer')?.['display-name'] === 'Kept Peer',
        5000,
        'first session holds it',
      );
      conn.detach();
      await until(() => conn.state === 'disconnected', 5000, 'detached');

      const me = ircd.client('mrestore')!;
      const sentBefore = me.sent.length;
      const conn2 = ircManager.startNetwork(userId, network.id)!;
      try {
        await until(() => conn2.state === 'connected', 5000, 'reattached');
        const since = () => me.sent.slice(sentBefore);
        await until(
          () => since().some((l) => l === 'METADATA #kept SYNC'),
          5000,
          'the restore asked for the channel',
        );
        expect(since()).toContain('METADATA * SYNC');
        // And the new process holds what the first one did — though the
        // socket's SUB drew no 774 this time.
        await until(
          () => conn2.userMetadataRecord('keptpeer')?.['display-name'] === 'Kept Peer',
          5000,
          'second session holds it',
        );
        expect(since().filter((l) => l.startsWith('774'))).toEqual([]);
      } finally {
        conn2.dispose();
        ircManager.connectionsForUser(userId).delete(network.id);
      }
    } finally {
      peer.socket.destroy();
    }
  }, 30000);
});
