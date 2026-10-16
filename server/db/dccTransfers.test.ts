// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { beforeAll, describe, expect, it } from 'vitest';

import db from './index.js';
import { createNetwork } from './networks.js';
import { createUser } from './users.js';
import {
  enqueueXdccPacks,
  findArmedRequest,
  findResumableTransfer,
  markXdccRequested,
  nextXdccRequests,
  removeXdccPacks,
  settleInterruptedDccReceives,
  getDccTransfer,
  insertDccTransfer,
  listDccTransfers,
  markDccCompleted,
  markDccReceiving,
  updateDccReceivedBytes,
  updateDccTransferState,
} from './dccTransfers.js';

let userId: number;
let networkId: number;
beforeAll(() => {
  userId = createUser('dcc-alice').id;
  networkId = createNetwork(userId, {
    name: 'rizon',
    host: 'irc.rizon.net',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!.id;
});

describe('dccTransfers', () => {
  // #1084: the checkpoint's row is what gets published, so it is the row as
  // written, and only ever the caller's own.
  it('checkpoints progress and hands back the row it wrote, for its owner only', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'bot',
      filename: 'progress.bin',
      advertised_size: 100,
      state: 'receiving',
    });
    expect(updateDccReceivedBytes(userId, id, 40)).toEqual(getDccTransfer(userId, id));
    expect(getDccTransfer(userId, id)!.received_bytes).toBe(40);
    const mallory = createUser('dcc-mallory').id;
    expect(updateDccReceivedBytes(mallory, id, 99)).toBeUndefined();
    expect(getDccTransfer(userId, id)!.received_bytes).toBe(40);
  });

  it('inserts a pending_approval offer and reads it back exactly', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: '[EWG]MArchive',
      filename: 'scene.mkv',
      advertised_size: 5_368_709_120, // > 4 GiB — must stay exact (64-bit INTEGER)
      state: 'pending_approval',
    });
    const row = getDccTransfer(userId, id)!;
    expect(row.state).toBe('pending_approval');
    expect(row.advertised_size).toBe(5_368_709_120);
    expect(row.received_bytes).toBe(0);
    expect(row.passive).toBe(0);
    expect(row.peer_nick).toBe('[EWG]MArchive');
    expect(row.direction).toBe('recv');
  });

  it('records passive offers with their token', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'bot',
      filename: 'f.bin',
      advertised_size: 10,
      state: 'requested',
      passive: true,
      token: 42,
    });
    const row = getDccTransfer(userId, id)!;
    expect(row.passive).toBe(1);
    expect(row.token).toBe(42);
  });

  it('collates peer_nick NOCASE so an offer matches the trigger regardless of casing', () => {
    insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'BotName',
      filename: 'f',
      advertised_size: 1,
      state: 'requested',
    });
    const found = db.prepare('SELECT id FROM dcc_transfers WHERE peer_nick = ?').get('botname');
    expect(found).toBeTruthy();
  });

  it('transitions state with an error and lists newest-first', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'b',
      filename: 'last.mkv',
      advertised_size: 1,
      state: 'pending_approval',
    });
    updateDccTransferState(id, 'cancelled', 'user cancelled');
    const row = getDccTransfer(userId, id)!;
    expect(row.state).toBe('cancelled');
    expect(row.error).toBe('user cancelled');

    const list = listDccTransfers(userId);
    expect(list.map((r) => r.id)).toContain(id);
    // newest-first ordering
    expect(list.toSorted((a, b) => b.id - a.id).map((r) => r.id)).toEqual(list.map((r) => r.id));
  });

  it('scopes reads to the owning user', () => {
    const other = createUser('dcc-bob').id;
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'b',
      filename: 'p.mkv',
      advertised_size: 1,
      state: 'pending_approval',
    });
    expect(getDccTransfer(other, id)).toBeUndefined();
  });

  it('findArmedRequest matches a recent request (NOCASE) but not an expired one', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'QueueBot',
      filename: 'XDCC #1',
      advertised_size: 0,
      state: 'requested',
    });
    // Fresh + case-insensitive nick → matched.
    expect(findArmedRequest(userId, networkId, 'queuebot')?.id).toBe(id);
    // Aged past the arm TTL (120 min) → no longer matched, so a later unsolicited
    // offer from that nick can't auto-accept.
    db.prepare("UPDATE dcc_transfers SET created_at = datetime('now','-3 hours') WHERE id = ?").run(
      id,
    );
    expect(findArmedRequest(userId, networkId, 'QueueBot')).toBeUndefined();
  });

  it('findResumableTransfer returns an incomplete row, not a completed one', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'b',
      filename: 'big.iso',
      advertised_size: 100,
      state: 'requested',
    });
    markDccReceiving(id, {
      filename: 'big.iso',
      advertised_size: 100,
      destination_path: '/data/big.iso',
      received_bytes: 40,
    });
    updateDccTransferState(id, 'failed', 'dropped');
    expect(findResumableTransfer(userId, networkId, 'big.iso')?.id).toBe(id);

    // A completed transfer of a different file is not resumable.
    const done = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'b',
      filename: 'done.iso',
      advertised_size: 10,
      state: 'requested',
    });
    markDccReceiving(done, {
      filename: 'done.iso',
      advertised_size: 10,
      destination_path: '/data/done.iso',
      received_bytes: 10,
    });
    markDccCompleted(done, 10);
    expect(findResumableTransfer(userId, networkId, 'done.iso')).toBeUndefined();
  });
});

// #1133: completing a receive keeps its file. The transfer mirrors the path,
// and the file must count, and claim its path, once.
describe('a completed receive', () => {
  it('becomes a kept file, counted once, whose path stays taken', async () => {
    const { dccUsageBytes, dccPathClaimed } = await import('./dccTransfers.js');
    const owner = createUser('dcc-kept').id;
    const id = insertDccTransfer(owner, {
      network_id: null as unknown as number,
      peer_nick: 'bot',
      filename: 'show.mkv',
      advertised_size: 700,
      state: 'pending_approval',
    });
    markDccReceiving(id, {
      filename: 'show.mkv',
      advertised_size: 700,
      destination_path: '/dcc/kept/show.mkv',
    });
    expect(dccUsageBytes(owner).committed).toBe(700);
    const file = markDccCompleted(id, 700, null, 'absent');
    expect(file).toMatchObject({
      name: 'show.mkv',
      size: 700,
      origin: 'received',
      transfer_id: id,
    });
    expect(getDccTransfer(owner, id)).toMatchObject({
      file_id: file!.id,
      destination_path: '/dcc/kept/show.mkv',
    });
    expect(dccUsageBytes(owner)).toEqual({ stored: 700, committed: 700 });
    expect(dccPathClaimed(owner, '/dcc/kept/show.mkv')).toBe(true);
    // Completing again keeps no second copy.
    expect(markDccCompleted(id, 700)).toBeNull();
    expect(dccUsageBytes(owner).stored).toBe(700);
    // The file claims its path alone too, as an uploaded one (#1086) will,
    // with no transfer mirroring it.
    db.prepare('UPDATE dcc_transfers SET destination_path = NULL WHERE id = ?').run(id);
    expect(dccPathClaimed(owner, '/dcc/kept/show.mkv')).toBe(true);
  });
});

// #1085: the XDCC queue's rows.
describe('the XDCC queue', () => {
  let owner: number;
  let net: number;
  beforeAll(() => {
    owner = createUser('dcc-queue-owner').id;
    net = createNetwork(owner, { name: 'q', host: 'h', port: 6697, tls: true, nick: 'q' })!.id;
  });
  const queueOf = (bot: string) =>
    (
      db
        .prepare(
          `SELECT pack, state, queue_seq, attempt FROM dcc_transfers
           WHERE user_id = ? AND peer_nick = ? ORDER BY queue_seq, id`,
        )
        .all(owner, bot) as { pack: number; state: string; attempt: number }[]
    ).map((r) => [r.pack, r.state, r.attempt]);

  it('queues at the back, a retry at the front, and never the same pack twice', () => {
    enqueueXdccPacks(owner, net, 'QBot', [5, 6, 5]);
    enqueueXdccPacks(owner, net, 'QBot', [6, 7]);
    enqueueXdccPacks(owner, net, 'QBot', [4], { front: true, attempt: 2 });
    expect(queueOf('QBot')).toEqual([
      [4, 'queued', 2],
      [5, 'queued', 1],
      [6, 'queued', 1],
      [7, 'queued', 1],
    ]);
  });

  it('offers each idle bot its next pack, and none to a bot with one out', () => {
    enqueueXdccPacks(owner, net, 'Idle', [1, 2]);
    enqueueXdccPacks(owner, net, 'Busy', [8, 9]);
    const [busy] = nextXdccRequests(owner, net).filter((r) => r.peer_nick === 'Busy');
    markXdccRequested(busy.id);
    const next = nextXdccRequests(owner, net).map((r) => [r.peer_nick, r.pack]);
    expect(next).toContainEqual(['Idle', 1]);
    expect(next.some(([bot]) => bot === 'Busy')).toBe(false);
  });

  it('takes packs out: waiting ones deleted, ones out handed back to cancel', () => {
    enqueueXdccPacks(owner, net, 'Rm', [1, 2, 3]);
    const [first] = nextXdccRequests(owner, net).filter((r) => r.peer_nick === 'Rm');
    markXdccRequested(first.id);
    const { deleted, out } = removeXdccPacks(owner, net, 'Rm', null);
    expect(deleted).toHaveLength(2);
    expect(out.map((r) => r.pack)).toEqual([1]);
  });

  it('at boot, fails what was receiving and puts queued packs back in line', () => {
    enqueueXdccPacks(owner, net, 'Boot', [1, 2]);
    const [one] = nextXdccRequests(owner, net).filter((r) => r.peer_nick === 'Boot');
    markXdccRequested(one.id);
    db.prepare(`UPDATE dcc_transfers SET state = 'receiving' WHERE id = ?`).run(one.id);
    const plain = insertDccTransfer(owner, {
      network_id: net,
      peer_nick: 'friend',
      filename: 'home.mov',
      advertised_size: 10,
      state: 'receiving',
    });
    settleInterruptedDccReceives();
    expect(getDccTransfer(owner, plain)!.state).toBe('failed');
    // Pack 1 failed, and a fresh row for it waits at the front, before 2.
    expect(getDccTransfer(owner, one.id)!.state).toBe('failed');
    expect(queueOf('Boot').filter(([, state]) => state !== 'failed')).toEqual([
      [1, 'queued', 1],
      [2, 'queued', 1],
    ]);
  });

  it('lists every open row, however many finished ones are newer', () => {
    const [waiting] = enqueueXdccPacks(owner, net, 'Old', [1]);
    for (let i = 0; i < 5; i++) {
      const id = insertDccTransfer(owner, {
        network_id: net,
        peer_nick: 'x',
        filename: `done${i}`,
        advertised_size: 1,
        state: 'requested',
      });
      updateDccTransferState(id, 'completed');
    }
    const listed = listDccTransfers(owner, { limit: 2 }).map((r) => r.id);
    expect(listed).toContain(waiting);
    expect(listed.length).toBeGreaterThanOrEqual(3);
  });
});
