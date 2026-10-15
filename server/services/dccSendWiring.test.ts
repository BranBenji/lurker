// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC SEND wiring (#1086): an offer of one of the account's files becoming a
// send on IrcConnection. The wire grammar is unit-pinned in dcc.test.ts and the
// socket engine in dccSender.test.ts; these exercise the plumbing — the offer
// that goes out, the peer connecting (or answering a passive offer), RESUME
// answered with ACCEPT, and every way an offer ends without a send.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import db from '../db/index.js';
import { createNetwork } from '../db/networks.js';
import { createUser } from '../db/users.js';
import {
  CAPABILITY_DCC_RECEIVE,
  CAPABILITY_DCC_SEND,
  setUserCapability,
} from '../db/userCapabilities.js';
import { keepUploadedDccFile, type DccFile } from '../db/dccFiles.js';
import { getDccTransfer, failInterruptedDccSends } from '../db/dccTransfers.js';
import { encodeDccAddress } from './dcc.js';
import { IrcConnection } from './ircConnection.js';
import { activeDccListenerCount, resetDccListeners } from './dccListener.js';

// Below 32768 (see dccChatWiring.test.ts), and apart from the other DCC test
// files' ranges, which can run in parallel.
const LISTEN_MIN = 24860;
const LISTEN_MAX = 24869;

const DATA = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 253));
let tmpDir: string;
let file: DccFile & { path: string };

beforeAll(() => {
  createUser('dcc-send-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-send-wiring-'));
  const p = path.join(tmpDir, 'my file.bin');
  fs.writeFileSync(p, DATA);
  file = {
    ...keepUploadedDccFile(1, { path: p, name: 'my file.bin', size: DATA.length }),
    path: p,
  };
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const sockets: net.Socket[] = [];
const peers: net.Server[] = [];
afterEach(() => {
  for (const k of [
    'LURKER_DCC_ENABLED',
    'LURKER_DCC_ALLOW_PRIVATE_HOSTS',
    'LURKER_DCC_EXTERNAL_HOST',
    'LURKER_DCC_LISTEN_BIND',
    'LURKER_DCC_LISTEN_PORT_MIN',
    'LURKER_DCC_LISTEN_PORT_MAX',
  ]) {
    delete process.env[k];
  }
  setUserCapability(1, CAPABILITY_DCC_SEND, false);
  db.prepare('DELETE FROM dcc_transfers').run();
  for (const s of sockets.splice(0)) s.destroy();
  for (const p of peers.splice(0)) p.close();
  resetDccListeners();
});

function makeConn(networkFields: Record<string, unknown> = {}): IrcConnection {
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
      ...networkFields,
    },
    onEvent: () => {},
  });
}

function harness(networkFields: Record<string, unknown> = {}) {
  const conn = makeConn(networkFields);
  conn.state = 'connected';
  const ctcpRequest = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const ctcpResponse = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const ephemeral: Array<Record<string, unknown>> = [];
  const frames: Array<Record<string, unknown>> = [];
  conn.client.ctcpRequest = ctcpRequest;
  conn.client.ctcpResponse = ctcpResponse;
  conn.publish = () => undefined;
  conn.publishEphemeral = (event: Record<string, unknown>) => {
    ephemeral.push(event);
  };
  conn.onUserFrame = (frame) => {
    frames.push(frame as Record<string, unknown>);
  };
  // The body of the n-th-from-last outgoing CTCP DCC request.
  const sent = (back = 1): string | null => {
    const call = ctcpRequest.mock.calls.at(-back);
    return call ? call.slice(2).join(' ') : null;
  };
  const lines = () => ephemeral.filter((e) => e.type === 'ctcp').map((e) => String(e.text ?? ''));
  const from = (nick: string, body: string) =>
    conn.client.emit('ctcp request', { nick, type: 'DCC', message: `DCC ${body}` });
  return { conn, ctcpRequest, ctcpResponse, sent, lines, frames, from };
}

function enableSend() {
  process.env.LURKER_DCC_ENABLED = '1';
  setUserCapability(1, CAPABILITY_DCC_SEND, true);
}

function enableListening() {
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

const row = (id: number) => getDccTransfer(1, id)!;

function offer(
  h: ReturnType<typeof harness>,
  opts: { passive?: boolean; nick?: string } = {},
): number {
  const result = h.conn.offerDccSend(file, opts.nick ?? 'bob', { passive: opts.passive });
  if (!('transferId' in result)) throw new Error(result.error);
  return result.transferId;
}

// Receive on `sock` the way a DCC receiver does, ACKing from `base`, until
// `size` bytes in all; resolves with what arrived.
function receive(sock: net.Socket, size: number, base = 0): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = base;
    sock.on('error', () => {});
    sock.on('data', (d: Buffer) => {
      chunks.push(d);
      total += d.length;
      const ack = Buffer.alloc(4);
      ack.writeUInt32BE(total % 0x1_0000_0000, 0);
      sock.write(ack);
      if (total >= size) {
        sock.end();
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

// The port an active offer advertised: `SEND "<name>" <addr> <port> <size>`.
function offeredPort(body: string): number {
  const m = /^SEND "my file\.bin" (\d+) (\d+) (\d+)$/.exec(body);
  if (!m) throw new Error(`not an active offer: ${body}`);
  expect(m[1]).toBe(encodeDccAddress('203.0.113.5'));
  expect(Number(m[3])).toBe(DATA.length);
  return Number(m[2]);
}

function dial(port: number): net.Socket {
  const sock = net.connect({ host: '127.0.0.1', port });
  sockets.push(sock);
  return sock;
}

describe('offering a file', () => {
  it('offers on a listening port and sends the file to whoever connects', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    expect(row(id)).toMatchObject({
      direction: 'send',
      state: 'offered',
      peer_nick: 'bob',
      filename: 'my file.bin',
      advertised_size: DATA.length,
      file_id: file.id,
    });
    await waitFor(() => h.sent() !== null);
    const port = offeredPort(h.sent()!);
    expect(port).toBeGreaterThanOrEqual(LISTEN_MIN);
    expect(port).toBeLessThanOrEqual(LISTEN_MAX);

    const got = await receive(dial(port), DATA.length);
    expect(got.equals(DATA)).toBe(true);
    await waitFor(() => row(id).state === 'completed');
    expect(row(id).received_bytes).toBe(DATA.length);
    expect(activeDccListenerCount()).toBe(0);
    expect(h.lines()).toContain(`DCC: sent "my file.bin" (293.0 KB) to bob`);
    // Every state reached the user's tabs.
    const states = h.frames
      .filter((f) => f.kind === 'dcc-transfer')
      .map((f) => (f.transfer as { state: string }).state);
    expect(states).toEqual(expect.arrayContaining(['offered', 'sending', 'completed']));
  });

  it('answers RESUME with ACCEPT and sends only the rest', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    await waitFor(() => h.sent() !== null);
    const port = offeredPort(h.sent()!);

    // The receiver names the file its own way; irssi matches by port.
    h.from('bob', `RESUME file.bin ${port} 100000`);
    expect(h.sent()).toBe(`ACCEPT "my file.bin" ${port} 100000`);

    const got = await receive(dial(port), DATA.length, 100_000);
    expect(got.equals(DATA.subarray(100_000))).toBe(true);
    await waitFor(() => row(id).state === 'completed');
  });

  it('withdraws an offer the peer asks to resume past its end', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    await waitFor(() => h.sent() !== null);
    const port = offeredPort(h.sent()!);
    h.from('bob', `RESUME file.bin ${port} ${DATA.length}`);
    expect(h.ctcpResponse).toHaveBeenCalledWith('bob', 'DCC', 'REJECT SEND "my file.bin"');
    expect(row(id)).toMatchObject({ state: 'failed' });
    expect(activeDccListenerCount()).toBe(0);
  });

  it('ignores a RESUME for a port it never offered, or from someone else', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    await waitFor(() => h.sent() !== null);
    const port = offeredPort(h.sent()!);
    const calls = h.ctcpRequest.mock.calls.length;
    h.from('bob', `RESUME file.bin ${port + 1} 10`);
    h.from('carol', `RESUME file.bin ${port} 10`);
    expect(h.ctcpRequest.mock.calls.length).toBe(calls);
    expect(row(id).state).toBe('offered');
  });

  it('marks an offer the peer declines rejected, and frees its port', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    await waitFor(() => activeDccListenerCount() === 1);
    h.conn.client.emit('ctcp response', {
      nick: 'bob',
      type: 'DCC',
      message: 'DCC REJECT SEND "my file.bin"',
    });
    expect(row(id).state).toBe('rejected');
    expect(activeDccListenerCount()).toBe(0);
    expect(h.lines().at(-1)).toBe('DCC: bob declined "my file.bin"');
  });

  it('withdraws an offer on cancel, and frees its port', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    await waitFor(() => activeDccListenerCount() === 1);
    h.conn.cancelDcc(id);
    expect(row(id).state).toBe('cancelled');
    expect(activeDccListenerCount()).toBe(0);
  });

  it('expires an offer nobody takes, and keeps the file', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    await waitFor(() => activeDccListenerCount() === 1);
    (h.conn as unknown as { expireDccSend(id: number): void }).expireDccSend(id);
    expect(row(id)).toMatchObject({ state: 'failed', error: 'not accepted within 5 minutes' });
    expect(activeDccListenerCount()).toBe(0);
    expect(fs.existsSync(file.path)).toBe(true);
  });

  it('cancels a send in flight', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    await waitFor(() => h.sent() !== null);
    const sock = dial(offeredPort(h.sent()!));
    sock.on('error', () => {});
    sock.pause(); // a receiver that isn't reading keeps the send in flight
    await waitFor(() => row(id).state === 'sending');
    h.conn.cancelDcc(id);
    await waitFor(() => row(id).state === 'cancelled');
    expect(h.lines().at(-1)).toBe('DCC: cancelled sending "my file.bin" to bob');
  });

  it('ends offers and sends when the connection is disposed', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const id = offer(h);
    await waitFor(() => activeDccListenerCount() === 1);
    h.conn.dispose();
    expect(row(id).state).toBe('cancelled');
    expect(activeDccListenerCount()).toBe(0);
  });
});

describe('a passive offer', () => {
  it('offers port 0 and a token, then connects to where the receiver says', async () => {
    enableSend();
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    const h = harness();
    const id = offer(h, { passive: true });
    const m = /^SEND "my file\.bin" 16843009 0 (\d+) (\d+)$/.exec(h.sent()!);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(DATA.length);
    const token = m![2];
    expect(row(id)).toMatchObject({ passive: 1, token: Number(token) });

    // The receiver listens, and answers with its address, port and our token.
    let got!: Promise<Buffer>;
    const listening = net.createServer((sock) => {
      got = receive(sock, DATA.length);
    });
    peers.push(listening);
    await new Promise<void>((r) => listening.listen(0, '127.0.0.1', r));
    const port = (listening.address() as net.AddressInfo).port;
    h.from(
      'bob',
      `SEND "my file.bin" ${encodeDccAddress('127.0.0.1')} ${port} ${DATA.length} ${token}`,
    );
    await waitFor(() => row(id).state === 'completed');
    expect((await got).equals(DATA)).toBe(true);
  });

  it('answers a passive RESUME with port 0 and the token', () => {
    enableSend();
    const h = harness();
    offer(h, { passive: true });
    const token = /(\d+)$/.exec(h.sent()!)![1];
    h.from('bob', `RESUME "my file.bin" 0 5000 ${token}`);
    expect(h.sent()).toBe(`ACCEPT "my file.bin" 0 5000 ${token}`);
  });

  it('refuses to connect to a private address without the opt-in', () => {
    enableSend();
    const h = harness();
    const id = offer(h, { passive: true });
    const token = /(\d+)$/.exec(h.sent()!)![1];
    h.from(
      'bob',
      `SEND "my file.bin" ${encodeDccAddress('127.0.0.1')} 24999 ${DATA.length} ${token}`,
    );
    expect(row(id)).toMatchObject({ state: 'failed', error: 'blocked address 127.0.0.1' });
  });

  // echo-message hands our own offer back. It must not read as one from us.
  // With the receive grant, so an offer from anyone else would be recorded.
  it('ignores its own offer echoed back', () => {
    enableSend();
    setUserCapability(1, CAPABILITY_DCC_RECEIVE, true);
    try {
      const h = harness();
      offer(h, { passive: true });
      h.from('carol', h.sent()!);
      const offers = db
        .prepare(`SELECT COUNT(*) AS n FROM dcc_transfers WHERE direction = 'recv'`)
        .get() as { n: number };
      expect(offers.n).toBe(0);
    } finally {
      setUserCapability(1, CAPABILITY_DCC_RECEIVE, false);
    }
  });
});

describe('refusing an offer', () => {
  it('refuses an active offer with nowhere to listen, and says what to do', () => {
    enableSend();
    const h = harness();
    const result = h.conn.offerDccSend(file, 'bob');
    expect(result).toMatchObject({ status: 409, error: expect.stringMatching(/-passive/) });
  });

  it('refuses a channel, all four sigils', () => {
    enableSend();
    enableListening();
    const h = harness();
    for (const target of ['#room', '&local', '+modeless', '!12345safe']) {
      expect(h.conn.offerDccSend(file, target)).toMatchObject({ status: 400 });
    }
  });

  it('refuses while the network is not connected', () => {
    enableSend();
    enableListening();
    const h = harness();
    h.conn.state = 'reconnecting';
    expect(h.conn.offerDccSend(file, 'bob')).toMatchObject({ status: 409 });
  });

  it('refuses a proxied network', () => {
    enableSend();
    enableListening();
    const h = harness({
      proxy_enabled: 1,
      proxy_type: 'socks5',
      proxy_host: 'proxy.example',
      proxy_port: 1080,
    });
    expect(h.conn.offerDccSend(file, 'bob')).toMatchObject({
      status: 409,
      error: expect.stringMatching(/proxy/),
    });
  });

  it('refuses a file no longer on disk as it was', () => {
    enableSend();
    enableListening();
    const h = harness();
    expect(h.conn.offerDccSend({ ...file, size: file.size + 1 }, 'bob')).toMatchObject({
      status: 410,
    });
  });
});

describe('a restart', () => {
  it('fails what was offered or sending, and nothing else', async () => {
    enableSend();
    enableListening();
    const h = harness();
    const offered = offer(h);
    const done = offer(h);
    db.prepare(`UPDATE dcc_transfers SET state = 'completed' WHERE id = ?`).run(done);
    expect(failInterruptedDccSends()).toBe(1);
    expect(row(offered)).toMatchObject({ state: 'failed', error: 'the server restarted' });
    expect(row(done).state).toBe('completed');
    h.conn.dispose();
  });
});
