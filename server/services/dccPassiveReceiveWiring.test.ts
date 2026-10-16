// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Receiving a passive DCC SEND (#1145): the sender can't listen, so we do,
// answer with where to connect, and take the file over the connection they
// make. The reply grammar is unit-pinned in dcc.test.ts; these exercise the
// plumbing, from the offer to the file on disk, and every way it ends early.

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
  getDccTransfer,
  insertDccTransfer,
  listDccTransfers,
  markDccReceiving,
  updateDccTransferState,
} from '../db/dccTransfers.js';
import { encodeDccAddress } from './dcc.js';
import { IrcConnection } from './ircConnection.js';
import { activeDccListenerCount, resetDccListeners } from './dccListener.js';

// Below 32768 (see dccChatWiring.test.ts), and apart from the other DCC test
// files' ranges, which can run in parallel.
const LISTEN_MIN = 24880;
const LISTEN_MAX = 24889;
const ADDR = encodeDccAddress('203.0.113.5');

const DATA = Buffer.from(Array.from({ length: 50_000 }, (_, i) => i % 251));
let tmpDir: string;

beforeAll(() => {
  createUser('dcc-pasv-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

const sockets: net.Socket[] = [];
afterEach(() => {
  for (const k of [
    'LURKER_DCC_ENABLED',
    'LURKER_DCC_DIR',
    'LURKER_DCC_EXTERNAL_HOST',
    'LURKER_DCC_LISTEN_BIND',
    'LURKER_DCC_LISTEN_PORT_MIN',
    'LURKER_DCC_LISTEN_PORT_MAX',
  ]) {
    delete process.env[k];
  }
  setUserCapability(1, CAPABILITY_DCC_RECEIVE, false);
  db.prepare('DELETE FROM dcc_transfers').run();
  db.prepare('DELETE FROM dcc_files').run();
  for (const s of sockets.splice(0)) s.destroy();
  resetDccListeners();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
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
  const conn = makeConn();
  conn.state = 'connected';
  const ctcpRequest = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const ephemeral: Array<Record<string, unknown>> = [];
  conn.client.ctcpRequest = ctcpRequest;
  conn.client.ctcpResponse = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  conn.client.say = vi.fn<(target: string, text: string) => void>();
  // DCC status lines are stored lines in the peer's DM (#1085).
  conn.publish = (event: Record<string, unknown>) => {
    ephemeral.push(event);
    return undefined;
  };
  conn.publishEphemeral = (event: Record<string, unknown>) => {
    ephemeral.push(event);
  };
  conn.onUserFrame = () => {};
  // Every outgoing CTCP DCC request body, oldest first.
  const sent = (): string[] => ctcpRequest.mock.calls.map((c) => c.slice(2).join(' '));
  const lines = () =>
    ephemeral.filter((e) => e.type === 'ctcp' || e.type === 'dcc').map((e) => String(e.text ?? ''));
  const from = (nick: string, body: string) =>
    conn.client.emit('ctcp request', {
      nick,
      target: 'alice',
      type: 'DCC',
      message: `DCC ${body}`,
    });
  return { conn, sent, lines, from };
}

function enable(opts: { listen?: boolean } = {}) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-pasv-recv-'));
  process.env.LURKER_DCC_ENABLED = '1';
  process.env.LURKER_DCC_DIR = tmpDir;
  setUserCapability(1, CAPABILITY_DCC_RECEIVE, true);
  if (opts.listen === false) return;
  process.env.LURKER_DCC_EXTERNAL_HOST = '203.0.113.5';
  process.env.LURKER_DCC_LISTEN_BIND = '127.0.0.1';
  process.env.LURKER_DCC_LISTEN_PORT_MIN = String(LISTEN_MIN);
  process.env.LURKER_DCC_LISTEN_PORT_MAX = String(LISTEN_MAX);
}

function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const onlyRow = () => {
  const rows = listDccTransfers(1);
  expect(rows).toHaveLength(1);
  return rows[0];
};

// The port in our answer to a passive offer, checking the rest of it:
// `SEND <name> <our addr> <port> <size> <token>`.
function answeredPort(body: string, name: string, size: number, token: number): number {
  const m = /^SEND (.+) (\d+) (\d+) (\d+) (\d+)$/.exec(body);
  if (!m) throw new Error(`not an answer: ${body}`);
  expect(m[1]).toBe(name);
  expect(m[2]).toBe(ADDR);
  expect(Number(m[4])).toBe(size);
  expect(Number(m[5])).toBe(token);
  const port = Number(m[3]);
  expect(port).toBeGreaterThanOrEqual(LISTEN_MIN);
  expect(port).toBeLessThanOrEqual(LISTEN_MAX);
  return port;
}

// Connect to `port` the way a passive sender does and send `data`.
function sendTo(port: number, data: Buffer): net.Socket {
  const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(data));
  sock.on('error', () => {});
  sockets.push(sock);
  return sock;
}

// Put a partial of `name` on disk with the failed row that owns it.
function seedPartial(name: string, have: number): string {
  const dir = path.join(tmpDir, 'dcc-pasv-alice');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, DATA.subarray(0, have));
  const prior = insertDccTransfer(1, {
    network_id: 1,
    peer_nick: 'bob',
    filename: name,
    advertised_size: DATA.length,
    state: 'requested',
  });
  markDccReceiving(prior, {
    filename: name,
    advertised_size: DATA.length,
    destination_path: p,
    received_bytes: have,
  });
  updateDccTransferState(prior, 'failed', 'interrupted');
  return p;
}

describe('a passive offer', () => {
  it('is answered with where to connect, and the file comes over that connection', async () => {
    enable();
    const h = harness();
    // HexChat's shape: a quoted name, its placeholder address, and irssi or
    // halloy can pick token 0.
    h.from('bob', `SEND "my show.mkv" 199 0 ${DATA.length} 0`);
    const offered = onlyRow();
    expect(offered).toMatchObject({ state: 'pending_approval', passive: 1, token: 0 });
    expect(h.lines()).toContain('DCC: bob offered "my show.mkv" (48.8 KB) via DCC SEND (passive)');

    h.conn.acceptPendingDcc(offered);
    await waitFor(() => h.sent().length === 1);
    // Their name as they wrote it, their size and their token.
    const port = answeredPort(h.sent()[0], '"my show.mkv"', DATA.length, 0);
    expect(h.lines()).toContain(
      'DCC: accepted "my show.mkv" (48.8 KB) from bob, waiting for them to connect…',
    );

    sendTo(port, DATA);
    await waitFor(() => getDccTransfer(1, offered.id)?.state === 'completed');
    const done = getDccTransfer(1, offered.id)!;
    expect(done.received_bytes).toBe(DATA.length);
    expect(fs.readFileSync(done.destination_path!).equals(DATA)).toBe(true);
    expect(activeDccListenerCount()).toBe(0);
  });

  it("takes halloy's offer, whose name is unquoted, from an XDCC request", async () => {
    enable();
    const h = harness();
    h.conn.say('bob', 'xdcc send #3');
    h.from('bob', `SEND my show.mkv 2130706433 0 ${DATA.length} 4242`);
    await waitFor(() => h.sent().length === 1);
    const port = answeredPort(h.sent()[0], '"my show.mkv"', DATA.length, 4242);
    sendTo(port, DATA);
    await waitFor(() => onlyRow().state === 'completed');
    expect(onlyRow().filename).toBe('my show.mkv');
  });

  it('asks to resume a partial first, and answers once the sender accepts', async () => {
    enable();
    const have = 20_000;
    const partial = seedPartial('show.mkv', have);
    const h = harness();
    h.conn.say('bob', 'xdcc send #1');
    h.from('bob', `SEND show.mkv 16843009 0 ${DATA.length} 9`);
    expect(h.sent()).toEqual([`RESUME show.mkv 0 ${have} 9`]);
    expect(activeDccListenerCount()).toBe(0);

    // An ACCEPT carrying someone else's token is not about ours.
    h.from('bob', `ACCEPT show.mkv 0 ${have} 8`);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sent()).toHaveLength(1);
    expect(activeDccListenerCount()).toBe(0);

    h.from('bob', `ACCEPT show.mkv 0 ${have} 9`);
    await waitFor(() => h.sent().length === 2);
    const port = answeredPort(h.sent()[1], 'show.mkv', DATA.length, 9);
    sendTo(port, DATA.subarray(have));
    await waitFor(() =>
      listDccTransfers(1).some((r) => r.filename === 'show.mkv' && r.state === 'completed'),
    );
    expect(fs.readFileSync(partial).equals(DATA)).toBe(true);
  });

  it("matches the ACCEPT by token, whatever name the sender's ACCEPT carries", async () => {
    enable();
    const have = 20_000;
    seedPartial('show.mkv', have);
    const h = harness();
    h.conn.say('bob', 'xdcc send #1');
    h.from('bob', `SEND show.mkv 16843009 0 ${DATA.length} 9`);
    h.from('bob', `ACCEPT file.ext 0 ${have} 9`);
    await waitFor(() => h.sent().length === 2);
    expect(answeredPort(h.sent()[1], 'show.mkv', DATA.length, 9)).toBeGreaterThan(0);
  });
});

describe('two passive resumes from one peer with one token', () => {
  // irssi's tokens are 6 bits, so two of its offers can share one.
  it('answers the ACCEPT for the file it names', async () => {
    enable();
    seedPartial('a.mkv', 10_000);
    seedPartial('b.mkv', 20_000);
    const h = harness();
    h.conn.say('bob', 'xdcc send #1');
    h.from('bob', `SEND a.mkv 16843009 0 ${DATA.length} 7`);
    h.conn.say('bob', 'xdcc send #2');
    h.from('bob', `SEND b.mkv 16843009 0 ${DATA.length} 7`);
    expect(h.sent()).toEqual([`RESUME a.mkv 0 10000 7`, `RESUME b.mkv 0 20000 7`]);
    h.from('bob', `ACCEPT b.mkv 0 20000 7`);
    await waitFor(() => h.sent().length === 3);
    expect(answeredPort(h.sent()[2], 'b.mkv', DATA.length, 7)).toBeGreaterThan(0);
    const a = listDccTransfers(1).find((r) => r.filename === 'a.mkv' && r.state !== 'failed');
    expect(a?.state).toBe('receiving');
  });
});

describe('a passive offer that ends early', () => {
  it('says up front when this server has nowhere to listen, and refuses it', () => {
    enable({ listen: false });
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    expect(h.lines()).toContain(
      'DCC: bob offered "f.bin" (48.8 KB) via DCC SEND (passive), but this server has no listening port to take it on',
    );
    h.conn.acceptPendingDcc(onlyRow());
    expect(onlyRow()).toMatchObject({
      state: 'failed',
      error: 'this server has no listening port configured',
    });
    expect(h.sent()).toEqual([]);
  });

  it('is not an offer without a token', () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length}`);
    expect(listDccTransfers(1)).toEqual([]);
  });

  it('is not answered once it is older than any sender waits', () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    db.prepare('UPDATE dcc_transfers SET created_at = ?').run(old);
    h.conn.acceptPendingDcc(onlyRow());
    expect(onlyRow()).toMatchObject({
      state: 'failed',
      error: 'the offer expired, so ask them to send it again',
    });
    expect(h.sent()).toEqual([]);
  });

  it('fails, and frees the port, when the sender never connects', async () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    const offered = onlyRow();
    h.conn.acceptPendingDcc(offered);
    await waitFor(() => activeDccListenerCount() === 1 && h.sent().length === 1);
    // The listener's own timeout, as it ends: closed while still waiting.
    const listens = (
      h.conn as unknown as { dccPassiveListens: Map<number, { handle: { close(): void } }> }
    ).dccPassiveListens;
    listens.get(offered.id)!.handle.close();
    await waitFor(() => getDccTransfer(1, offered.id)?.state === 'failed');
    expect(getDccTransfer(1, offered.id)!.error).toBe('bob never connected');
    expect(h.lines()).toContain(
      'DCC: bob never connected to send "f.bin"; their offer may have expired',
    );
    expect(activeDccListenerCount()).toBe(0);
  });

  it('stops listening on cancel', async () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    const offered = onlyRow();
    h.conn.acceptPendingDcc(offered);
    await waitFor(() => activeDccListenerCount() === 1 && h.sent().length === 1);
    h.conn.cancelDcc(offered.id);
    expect(getDccTransfer(1, offered.id)!.state).toBe('cancelled');
    expect(activeDccListenerCount()).toBe(0);
  });

  it('stops listening when cancelled while the port binds', async () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    const offered = onlyRow();
    h.conn.acceptPendingDcc(offered);
    h.conn.cancelDcc(offered.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(getDccTransfer(1, offered.id)!.state).toBe('cancelled');
    expect(h.sent()).toEqual([]);
    expect(activeDccListenerCount()).toBe(0);
  });

  it('stops listening when the connection is disposed', async () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    const offered = onlyRow();
    h.conn.acceptPendingDcc(offered);
    await waitFor(() => activeDccListenerCount() === 1 && h.sent().length === 1);
    h.conn.dispose();
    expect(getDccTransfer(1, offered.id)!.state).toBe('cancelled');
    expect(activeDccListenerCount()).toBe(0);
  });

  it('ends a row whose connection is disposed while the port binds', async () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    const offered = onlyRow();
    h.conn.acceptPendingDcc(offered);
    h.conn.dispose();
    expect(getDccTransfer(1, offered.id)!.state).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 50));
    expect(getDccTransfer(1, offered.id)!.state).toBe('cancelled');
    expect(h.sent()).toEqual([]);
    expect(activeDccListenerCount()).toBe(0);
  });

  // A stopped network is unmapped, so a cancel after it never reaches the
  // connection.
  it('stops listening on a deliberate disconnect', async () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    const offered = onlyRow();
    h.conn.acceptPendingDcc(offered);
    await waitFor(() => activeDccListenerCount() === 1 && h.sent().length === 1);
    h.conn.disconnect('bye');
    expect(getDccTransfer(1, offered.id)!.state).toBe('cancelled');
    expect(activeDccListenerCount()).toBe(0);
  });

  it("doesn't answer when the network dropped while the port was binding", async () => {
    enable();
    const h = harness();
    h.from('bob', `SEND f.bin 16843009 0 ${DATA.length} 5`);
    const offered = onlyRow();
    h.conn.acceptPendingDcc(offered);
    h.conn.state = 'disconnected';
    await waitFor(() => getDccTransfer(1, offered.id)?.state === 'failed');
    expect(getDccTransfer(1, offered.id)!.error).toBe('the network disconnected');
    expect(h.sent()).toEqual([]);
    expect(activeDccListenerCount()).toBe(0);
  });
});
