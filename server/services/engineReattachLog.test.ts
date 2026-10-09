// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The stdout record of an engine re-attach (#1069): one `[engine]` line per
// connection when its catch-up ends, and one total once a burst of them has —
// so `docker logs … | grep '\[engine\]'` says how long the app was away and
// how much it was handed, without a line per message.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import { engineConnectionId } from './engineLink.js';
import { configureReattachLogForTests } from './engineReattachLog.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';

// Small enough that a few hundred lines overflow it, big enough for a handful.
const BUFFER_BYTES = 8 * 1024;
const FLOOD = 200;
// The burst's quiet spell, short here. A burst's total lands within two of
// these after its last catch-up; three is "it would have by now".
const QUIET_MS = 200;

let harness: EngineHarness;
let log: MockInstance<typeof console.log>;
let userId: number;

beforeAll(async () => {
  harness = await startEngineHarness({ secret: 'reattach-log-secret', bufferBytes: BUFFER_BYTES });
  userId = createUser('reattach-log').id;
  log = vi.spyOn(console, 'log');
  configureReattachLogForTests({ quietMs: QUIET_MS });
});

afterAll(async () => {
  log.mockRestore();
  configureReattachLogForTests({});
  await harness.stop();
});

const engineLines = (): string[] =>
  log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[engine]'));

function network(nick: string): Network {
  return createNetwork(userId, {
    name: nick,
    host: '127.0.0.1',
    port: harness.ircd.port,
    tls: 0,
    nick,
    autoconnect: 0,
  })!;
}

async function connect(net: Network): Promise<IrcConnection> {
  const conn = new IrcConnection({ network: net, onEvent: () => {} });
  conn.connect();
  await harness.until(() => conn.state === 'connected' && !conn.catchingUp, 5000, 'connected');
  return conn;
}

// The app "shuts down": detach, never QUIT, and the engine keeps the socket.
async function detach(conn: IrcConnection): Promise<void> {
  conn.detach();
  await harness.until(() => conn.state === 'disconnected', 5000, 'detached');
  expect(harness.engine.held()).toContain(engineConnectionId(userId, conn.network.id));
}

const buffered = (net: Network) =>
  harness.engine.info(engineConnectionId(userId, net.id))?.bufferedLines ?? 0;

// Until the engine's backlog for this connection has held still for a while:
// every line sent while the app was away has reached it (past any Nagle hold,
// ~40 ms), and the overflow has happened — before the attach, which is what
// makes it a gap. An overflowing buffer's line count stops at its cap.
async function settled(net: Network): Promise<void> {
  let last = -1;
  let since = Date.now();
  await harness.until(
    () => {
      const now = buffered(net);
      if (now !== last) {
        last = now;
        since = Date.now();
      }
      return now > 0 && Date.now() - since >= 200;
    },
    5000,
    `${net.nick}'s backlog settled`,
  );
}

const PER_CONN =
  /^\[engine\] network (\d+): re-attached \(away (\d+)ms, replay (\d+), backlog (\d+), gap (none|(\d+) dropped)\)$/;

describe('engine re-attach on stdout', () => {
  it('logs one line per connection and a total for the burst', async () => {
    const quiet = network('quietly');
    const flooded = network('flooded');
    const first = [await connect(quiet), await connect(flooded)];
    const detachedAt = Date.now();
    for (const c of first) await detach(c);

    // While the app is away: three lines for one, an overflow for the other.
    const quietBefore = buffered(quiet);
    for (let i = 0; i < 3; i++) harness.ircd.say('peer', 'quietly', `away ${i}`);
    for (let i = 0; i < FLOOD; i++) {
      harness.ircd.say('peer', 'flooded', `flood ${i} ${'x'.repeat(60)}`);
    }
    await harness.until(() => buffered(quiet) >= quietBefore + 3, 5000, 'the three buffered');
    await settled(flooded);

    // Both CONNECTs out together, as a restart sends them: the engine answers
    // one at a time, so the first can be live before the second has attached.
    log.mockClear();
    const second = await Promise.all([connect(quiet), connect(flooded)]);
    const elapsed = Date.now() - detachedAt;
    await harness.until(() => engineLines().length >= 3, 5000, 'the stdout lines');

    const lines = engineLines();
    expect(lines).toHaveLength(3);
    const byNetwork = new Map(
      lines
        .map((l) => PER_CONN.exec(l))
        .filter((m) => m !== null)
        .map((m) => [Number(m[1]), m]),
    );
    expect([...byNetwork.keys()].toSorted()).toEqual([quiet.id, flooded.id].toSorted());

    const q = byNetwork.get(quiet.id)!;
    const f = byNetwork.get(flooded.id)!;
    for (const m of [q, f]) {
      expect(Number(m[2])).toBeGreaterThan(0);
      expect(Number(m[2])).toBeLessThanOrEqual(elapsed);
      // The registration burst is always in the replay.
      expect(Number(m[3])).toBeGreaterThan(0);
    }
    expect(Number(q[4])).toBeGreaterThanOrEqual(3);
    expect(q[5]).toBe('none');
    // What survived the overflow, and how much it lost: together at least the
    // flood, and the backlog alone short of it.
    const backlog = Number(f[4]);
    const dropped = Number(f[6]);
    expect(dropped).toBeGreaterThan(0);
    expect(backlog).toBeLessThan(FLOOD);
    expect(backlog + dropped).toBeGreaterThanOrEqual(FLOOD);

    // The total, once the burst has gone quiet, sums them.
    const replay = Number(q[3]) + Number(f[3]);
    const total = Number(q[4]) + backlog;
    expect(lines[2]).toMatch(
      new RegExp(
        `^\\[engine\\] 2 connections re-attached in \\d+\\.\\ds \\(replay ${replay}, backlog ${total}, gap on 1\\)$`,
      ),
    );
    // Nothing written per line: no message text reaches stdout.
    expect(log.mock.calls.some((c) => String(c[0]).includes('flood '))).toBe(false);

    // A connection re-attaching on its own writes its line and no total.
    await detach(second[0]);
    log.mockClear();
    const third = await connect(quiet);
    await harness.until(() => engineLines().length >= 1, 5000, 'the stdout line');
    await new Promise((r) => setTimeout(r, 3 * QUIET_MS));
    expect(engineLines()).toHaveLength(1);
    expect(engineLines()[0]).toMatch(PER_CONN);
    expect(engineLines()[0]).toContain(`network ${quiet.id}:`);

    third.detach();
    second[1].detach();
  }, 30000);
});
