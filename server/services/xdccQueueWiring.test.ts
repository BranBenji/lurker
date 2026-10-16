// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The XDCC queue (#1085) on IrcConnection: one queue per bot, one request out
// per bot at a time, every bot's at once; a bot answering holds the
// auto-accept; silence fails the request; a failure is retried once at the
// back; a disconnect puts what was out back at the front; cancelling tells
// the bot. The DB half is pinned in dccTransfers.test.ts.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import db from '../db/index.js';
import { createNetwork } from '../db/networks.js';
import { createUser } from '../db/users.js';
import { CAPABILITY_DCC_RECEIVE, setUserCapability } from '../db/userCapabilities.js';
import {
  findArmedRequest,
  getDccTransfer,
  listDccTransfers,
  type DccTransferRow,
} from '../db/dccTransfers.js';
import { IrcConnection } from './ircConnection.js';

beforeAll(() => {
  createUser('xdcc-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network 1
});

let tmpDir: string | null = null;
const senders: Array<{ close: () => void }> = [];
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LURKER_DCC_ENABLED;
  delete process.env.LURKER_DCC_DIR;
  delete process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS;
  delete process.env.LURKER_DCC_MAX_FILE_MB;
  setUserCapability(1, CAPABILITY_DCC_RECEIVE, false);
  db.prepare('DELETE FROM dcc_transfers').run();
  db.prepare('DELETE FROM dcc_files').run();
  for (const s of senders.splice(0)) s.close();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeConn(): IrcConnection {
  return new IrcConnection({
    network: {
      client_cert: null,
      client_key: null,
      proxy_enabled: 0,
      proxy_type: null,
      proxy_host: null,
      proxy_port: null,
      proxy_username: null,
      proxy_password: null,
      id: 1,
      user_id: 1,
      name: 'n',
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'alice',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 1,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
      position: 0,
      casemapping: null,
      created_at: new Date().toISOString(),
    },
    onEvent: () => {},
  });
}

function harness() {
  process.env.LURKER_DCC_ENABLED = '1';
  setUserCapability(1, CAPABILITY_DCC_RECEIVE, true);
  const conn = makeConn();
  conn.state = 'connected';
  const raw = vi.fn<(line: string) => void>();
  conn.client.raw = raw as unknown as typeof conn.client.raw;
  conn.client.ctcpRequest = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  conn.client.ctcpResponse = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const events: Array<Record<string, unknown>> = [];
  const frames: Array<Record<string, unknown>> = [];
  conn.publish = (event: Record<string, unknown>) => {
    events.push(event);
    return undefined;
  };
  conn.publishEphemeral = (event: Record<string, unknown>) => {
    events.push(event);
  };
  conn.onUserFrame = (frame) => {
    frames.push(frame as Record<string, unknown>);
  };
  // PRIVMSG lines written to the wire, as "target :text".
  const privmsgs = () =>
    raw.mock.calls
      .map(([line]) => /^PRIVMSG (\S+) :(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => `${m[1]} :${m[2]}`);
  const dccLines = () => events.filter((e) => e.type === 'dcc').map((e) => String(e.text));
  const botSays = (nick: string, text: string) =>
    conn.client.emit('message', {
      type: 'notice',
      nick,
      ident: 'bot',
      hostname: 'bots.example',
      target: 'alice',
      message: text,
      tags: {},
    });
  const offer = (nick: string, body: string) =>
    conn.client.emit('ctcp request', {
      nick,
      target: 'alice',
      type: 'DCC',
      message: `DCC ${body}`,
    });
  return { conn, raw, events, frames, privmsgs, dccLines, botSays, offer };
}

const rows = (): DccTransferRow[] =>
  listDccTransfers(1).sort((a, b) => (a.queue_seq ?? 0) - (b.queue_seq ?? 0) || a.id - b.id);
const byPack = (bot: string, pack: number) =>
  rows().filter((r) => r.peer_nick === bot && r.pack === pack);
const tick = () => new Promise((r) => setImmediate(r));

function startSender(payload: Buffer): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.write(payload, () => sock.end());
    });
    server.listen(0, '127.0.0.1', () => {
      senders.push({ close: () => server.close() });
      resolve({ port: (server.address() as net.AddressInfo).port });
    });
  });
}

function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe('queueing packs', () => {
  it('asks a bot for one pack at a time and waits with the rest', () => {
    const h = harness();
    expect(h.conn.queueXdcc('Bot', [29, 30, 31])).toHaveLength(3);
    expect(h.privmsgs()).toEqual(['Bot :XDCC SEND #29']);
    expect(rows().map((r) => [r.pack, r.state])).toEqual([
      [29, 'requested'],
      [30, 'queued'],
      [31, 'queued'],
    ]);
    expect(h.dccLines()).toContain('XDCC: queued #29–#31 from Bot');
    // The request is the user's own line in the bot's DM.
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'message',
        target: 'Bot',
        text: 'XDCC SEND #29',
        self: true,
      }),
    );
  });

  it("runs every bot's queue at once", () => {
    const h = harness();
    h.conn.queueXdcc('BotA', [1, 2]);
    h.conn.queueXdcc('BotB', [5]);
    expect(h.privmsgs()).toEqual(['BotA :XDCC SEND #1', 'BotB :XDCC SEND #5']);
  });

  it('skips a pack already waiting or out for that bot', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [1, 2]);
    expect(h.conn.queueXdcc('Bot', [1, 2, 3])).toHaveLength(1);
    expect(rows().map((r) => r.pack)).toEqual([1, 2, 3]);
  });

  it('waits for the connection, and asks once it is up', async () => {
    const h = harness();
    h.conn.state = 'disconnected';
    h.conn.queueXdcc('Bot', [7]);
    expect(h.privmsgs()).toEqual([]);
    h.conn.setState('connected');
    await tick();
    expect(h.privmsgs()).toEqual(['Bot :XDCC SEND #7']);
  });
});

describe('the bot answering, or not', () => {
  it('fails a request the bot never answers, retries it at the back, and moves on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    h.conn.queueXdcc('Bot', [29, 30]);
    vi.advanceTimersByTime(2 * 60_000 + 1);
    await tick();
    const first = byPack('Bot', 29);
    expect(first.map((r) => [r.state, r.attempt])).toEqual([
      ['failed', 1],
      ['queued', 2],
    ]);
    expect(first[0].error).toBe('no response from Bot');
    // #30 is out now; the retry of #29 waits behind it.
    expect(byPack('Bot', 30)[0].state).toBe('requested');
    expect(h.privmsgs().at(-1)).toBe('Bot :XDCC SEND #30');
    expect(h.dccLines().some((l) => l.startsWith('XDCC: #29 failed (no response from Bot)'))).toBe(
      true,
    );
  });

  it('holds the auto-accept for as long as the bot takes once it answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    h.conn.queueXdcc('Bot', [29]);
    h.botSays('bot', 'All slots full. Added you to the main queue for pack #29 in position 3.');
    const [row] = byPack('Bot', 29);
    expect(row.bot_acked_at).not.toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(getDccTransfer(1, row.id)?.state).toBe('requested');
    // Hours later, past the arm's window for an unanswered request.
    db.prepare(`UPDATE dcc_transfers SET requested_at = ?, created_at = ? WHERE id = ?`).run(
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      row.id,
    );
    expect(findArmedRequest(1, 1, 'Bot')?.id).toBe(row.id);
  });

  it('fails a request the bot refuses at once, and does not retry a missing pack', async () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [99, 100]);
    h.botSays('Bot', '** Invalid Pack Number, Try Again');
    await tick();
    const [row] = byPack('Bot', 99);
    expect(row.state).toBe('failed');
    expect(row.error).toBe('Bot: ** Invalid Pack Number, Try Again');
    expect(byPack('Bot', 99)).toHaveLength(1);
    expect(byPack('Bot', 100)[0].state).toBe('requested');
  });

  it('fails only the oldest request waiting on a bot that refuses, and not to retry', async () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [29]);
    h.conn.say('Bot', 'xdcc send #40');
    h.botSays('Bot', '** Invalid Pack Number, Try Again');
    await tick();
    expect(byPack('Bot', 29).map((r) => r.state)).toEqual(['failed']);
    expect(byPack('Bot', 40)[0].state).toBe('requested');
  });

  it('fails an answered request the bot later refuses', async () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [29, 30]);
    h.botSays('Bot', 'Added you to the main queue for pack #29 in position 2.');
    h.botSays('Bot', 'XDCC SEND denied, you must be on a known channel');
    await tick();
    expect(byPack('Bot', 29).map((r) => r.state)).toEqual(['failed']);
    expect(byPack('Bot', 30)[0].state).toBe('requested');
  });

  it('never throws from a status line it cannot keep', () => {
    const h = harness();
    h.conn.publish = () => {
      throw new Error('FOREIGN KEY constraint failed');
    };
    const line = (h.conn as unknown as { dccLine: (n: string, t: string) => void }).dccLine;
    expect(() => line.call(h.conn, 'Bot', 'DCC: received "x"')).not.toThrow();
  });

  it('does not spin on an answered request past its hours while the engine link is down', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness();
    h.conn.queueXdcc('Bot', [29]);
    h.botSays('Bot', 'Added you to the main queue.');
    h.conn.state = 'reconnecting';
    vi.advanceTimersByTime(13 * 3_600_000);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    expect(byPack('Bot', 29)[0].state).toBe('requested');
  });

  it('gives an answered request 12 hours for its offer, then moves on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness();
    h.conn.queueXdcc('Bot', [29, 30]);
    h.botSays('Bot', 'Added you to the main queue for pack #29 in position 40.');
    vi.advanceTimersByTime(11 * 3_600_000);
    expect(byPack('Bot', 29)[0].state).toBe('requested');
    vi.advanceTimersByTime(3_600_000 + 1);
    await tick();
    expect(byPack('Bot', 29)[0]).toMatchObject({
      state: 'failed',
      error: 'no offer from Bot in 12 hours',
    });
    expect(byPack('Bot', 30)[0].state).toBe('requested');
  });

  it('retries a failed pack only once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    h.conn.queueXdcc('Bot', [29]);
    vi.advanceTimersByTime(2 * 60_000 + 1);
    await tick();
    expect(byPack('Bot', 29).map((r) => r.state)).toEqual(['failed', 'requested']);
    vi.advanceTimersByTime(2 * 60_000 + 1);
    await tick();
    expect(byPack('Bot', 29).map((r) => r.state)).toEqual(['failed', 'failed']);
    expect(h.dccLines().at(-1)).toBe('XDCC: nothing left in the queue for Bot');
  });

  it('does not retry an offer it refused for a reason that would hold again', async () => {
    const h = harness();
    process.env.LURKER_DCC_MAX_FILE_MB = '1';
    h.conn.queueXdcc('Bot', [29]);
    h.offer('Bot', 'SEND big.mkv 2130706433 5000 5000000');
    await tick();
    expect(byPack('Bot', 29).map((r) => r.state)).toEqual(['failed']);
  });

  it('downloads the pack, then asks for the next', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-xdcc-'));
    process.env.LURKER_DCC_DIR = tmpDir;
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    const payload = Buffer.alloc(30_000, 7);
    const sender = await startSender(payload);
    const h = harness();
    h.conn.queueXdcc('Bot', [29, 30]);
    h.offer('Bot', `SEND ep29.mkv 2130706433 ${sender.port} ${payload.length}`);
    await waitFor(() => byPack('Bot', 29)[0]?.state === 'completed');
    await waitFor(() => byPack('Bot', 30)[0]?.state === 'requested');
    expect(h.privmsgs()).toEqual(['Bot :XDCC SEND #29', 'Bot :XDCC SEND #30']);
    expect(byPack('Bot', 29)[0].filename).toBe('ep29.mkv');
    expect(h.dccLines()).toContain('DCC: received "ep29.mkv" (29.3 KB) from Bot');
  });
});

describe('typed requests', () => {
  it('joins the bot queue as the request that is out', () => {
    const h = harness();
    h.conn.say('Bot', 'xdcc send #12');
    expect(rows().map((r) => [r.pack, r.state])).toEqual([[12, 'requested']]);
    // The queue waits for it before asking for anything else.
    h.conn.queueXdcc('Bot', [13]);
    expect(h.privmsgs()).toEqual(['Bot :xdcc send #12']);
    expect(byPack('Bot', 13)[0].state).toBe('queued');
  });

  it('takes a waiting pack out of the queue when it is typed early', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [1, 2]);
    h.conn.say('Bot', 'xdcc send #2');
    expect(byPack('Bot', 2).map((r) => r.state)).toEqual(['requested']);
    expect(h.frames).toContainEqual({ kind: 'dcc-transfers-cleared', ids: [expect.any(Number)] });
  });
});

describe('disconnects and cancels', () => {
  it('puts a request that was out back at the front when the connection drops', async () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [29, 30]);
    h.conn.setState('disconnected');
    expect(rows().map((r) => [r.pack, r.state])).toEqual([
      [29, 'queued'],
      [30, 'queued'],
    ]);
    h.conn.setState('connected');
    await tick();
    expect(h.privmsgs()).toEqual(['Bot :XDCC SEND #29', 'Bot :XDCC SEND #29']);
  });

  it('asks again on a fresh connection, which the bot never heard', async () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [29]);
    h.conn.state = 'connecting';
    h.conn.setState('connected');
    await tick();
    expect(h.privmsgs()).toEqual(['Bot :XDCC SEND #29', 'Bot :XDCC SEND #29']);
  });

  it('leaves requests out when only the link to the engine went', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [29]);
    (h.conn as unknown as { engineSocketAlive: boolean }).engineSocketAlive = true;
    h.conn.setState('disconnected');
    expect(byPack('Bot', 29)[0].state).toBe('requested');
  });

  it('says only the packs it actually queued', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [30]);
    h.conn.queueXdcc('Bot', [29, 30, 31, 32]);
    expect(h.dccLines()).toContain('XDCC: queued #29, #31 and #32 from Bot');
  });

  it('tells the bot when a request out is cancelled, then asks for the next', async () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [29, 30]);
    h.conn.cancelDcc(byPack('Bot', 29)[0].id);
    await tick();
    expect(h.privmsgs()).toEqual(['Bot :XDCC SEND #29', 'Bot :XDCC REMOVE', 'Bot :XDCC SEND #30']);
    // A cancel is the user's: no retry.
    expect(byPack('Bot', 29).map((r) => r.state)).toEqual(['cancelled']);
  });

  it('ends every request out to the bot when one is cancelled, as XDCC REMOVE does', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [1, 2]);
    h.conn.say('Bot', 'xdcc send #9');
    h.conn.cancelDcc(byPack('Bot', 1)[0].id);
    expect(byPack('Bot', 9)[0]).toMatchObject({ state: 'cancelled' });
    expect(h.privmsgs().filter((l) => l === 'Bot :XDCC REMOVE')).toHaveLength(1);
  });

  it('does not let a request from before the queue hold a bot forever', () => {
    const h = harness();
    db.prepare(
      `INSERT INTO dcc_transfers (user_id, network_id, peer_nick, filename, advertised_size, state)
       VALUES (1, 1, 'Bot', 'XDCC #1', 0, 'requested')`,
    ).run();
    h.conn.queueXdcc('Bot', [5]);
    expect(h.privmsgs()).toEqual(['Bot :XDCC SEND #5']);
  });

  it('moves the queue on through the connection mapped now', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    const pump = vi.fn<() => void>();
    h.conn.pumpXdcc = pump;
    h.conn.queueXdcc('Bot', [1, 2]);
    vi.advanceTimersByTime(2 * 60_000 + 1);
    await tick();
    expect(pump).toHaveBeenCalled();
  });

  it("doesn't call the bot silent while only the link to the engine is down", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    h.conn.queueXdcc('Bot', [1]);
    h.conn.state = 'reconnecting';
    vi.advanceTimersByTime(2 * 60_000 + 1);
    expect(byPack('Bot', 1)[0].state).toBe('requested');
    h.conn.state = 'connected';
    vi.advanceTimersByTime(2 * 60_000 + 1);
    expect(byPack('Bot', 1)[0].state).toBe('failed');
  });

  it('deletes a queued pack that is cancelled before its turn', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [29, 30]);
    const id = byPack('Bot', 30)[0].id;
    h.conn.cancelDcc(id);
    expect(getDccTransfer(1, id)).toBeUndefined();
    expect(h.frames).toContainEqual({ kind: 'dcc-transfers-cleared', ids: [id] });
  });

  it("empties a bot's queue, cancelling the pack that is out", () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [1, 2, 3]);
    expect(h.conn.unqueueXdcc('Bot', null)).toBe(3);
    expect(rows().map((r) => [r.pack, r.state])).toEqual([[1, 'cancelled']]);
    expect(h.dccLines()).toContain('XDCC: emptied the queue for Bot');
  });

  it('removes only the packs named', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [1, 2, 3, 4]);
    expect(h.conn.unqueueXdcc('Bot', [3, 4])).toBe(2);
    expect(rows().map((r) => r.pack)).toEqual([1, 2]);
    expect(h.dccLines()).toContain('XDCC: removed #3 and #4 from the queue for Bot');
  });

  it('puts what was out back in the queue when the connection is disposed', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [29]);
    h.conn.dispose('reconnect');
    expect(rows().map((r) => [r.pack, r.state])).toEqual([[29, 'queued']]);
  });

  it('a manual retry goes to the front', () => {
    const h = harness();
    h.conn.queueXdcc('Bot', [1, 2]);
    const failed = byPack('Bot', 1)[0];
    db.prepare(`UPDATE dcc_transfers SET state = 'failed' WHERE id = ?`).run(failed.id);
    h.conn.state = 'disconnected';
    h.conn.retryXdcc(getDccTransfer(1, failed.id)!);
    const queued = rows().filter((r) => r.state === 'queued');
    expect(queued.map((r) => [r.pack, r.attempt])).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });
});
