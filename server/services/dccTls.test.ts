// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The TLS layer under secure DCC (#1157), against the two peers that exist:
// KVIrc without a certificate, which offers only the anonymous suites, and a
// peer with a self-signed one (KVIrc given a cert, ZNC's schat module). The
// wire grammar is pinned in dcc.test.ts and the engines take a socket they
// are handed, so these are what makes a secure DCC secure at all.

// MUST be first — the certificate lives beside the DB, so DATABASE_PATH must
// point at a temp dir before anything resolves the data dir.
import '../test-utils/isolateDb.js';
import net from 'net';
import tls from 'tls';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DCC_DIAL_CIPHERS,
  dccSecureContext,
  describeDccTls,
  dialDccPeer,
  secureAcceptedDccSocket,
} from './dccTls.js';
import { startTlsPeer, tlsDial, type TlsPeer } from '../test-utils/dccTlsPeer.js';

const peers: TlsPeer[] = [];
const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(() => {
  for (const p of peers.splice(0)) p.close();
  for (const s of servers.splice(0)) s.close();
  for (const s of sockets.splice(0)) s.destroy();
});

function ready(socket: net.Socket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once('error', reject);
  });
}

function echoOnce(a: net.Socket, b: net.Socket, text: string): Promise<string> {
  const got = new Promise<string>((r) => b.once('data', (d) => r(d.toString())));
  a.write(text);
  return got;
}

async function plainServer(onConn: (s: net.Socket) => void): Promise<number> {
  const server = net.createServer(onConn);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as net.AddressInfo).port;
}

describe('dialDccPeer', () => {
  it('a plain dial is a plain socket, ready at connect', async () => {
    const port = await plainServer((s) => s.on('data', (d) => s.write(d)));
    const { socket, ready: event } = dialDccPeer('127.0.0.1', port, false);
    sockets.push(socket);
    expect(event).toBe('connect');
    expect(socket).not.toBeInstanceOf(tls.TLSSocket);
    await ready(socket, event);
    expect(await echoOnce(socket, socket, 'hi')).toBe('hi');
  });

  // ⚠⚠ The case that needed three deliberate choices in the dial's options
  // (dccTls.ts header): without any one of them this handshake fails.
  it('reaches a cert-less KVIrc listener over anonymous DH at TLS 1.2', async () => {
    const peer = await startTlsPeer({ anonymous: true });
    peers.push(peer);
    const { socket, ready: event } = dialDccPeer('127.0.0.1', peer.port, true);
    sockets.push(socket);
    expect(event).toBe('secureConnect');
    await ready(socket, event);
    const theirs = await peer.socket;
    const secured = socket as tls.TLSSocket;
    expect(secured.getProtocol()).toBe('TLSv1.2');
    expect(secured.getCipher().name).toMatch(/^(ADH|AECDH)-/);
    expect(await echoOnce(socket, theirs, 'hello\r\n')).toBe('hello\r\n');
  });

  it('gets an authenticated suite from a listener that has a certificate', async () => {
    const peer = await startTlsPeer();
    peers.push(peer);
    const { socket, ready: event } = dialDccPeer('127.0.0.1', peer.port, true);
    sockets.push(socket);
    await ready(socket, event);
    const secured = socket as tls.TLSSocket;
    expect(secured.getProtocol()).toBe('TLSv1.2');
    expect(secured.getCipher().name).not.toMatch(/^(ADH|AECDH)-/);
    // Nothing is verified: a self-signed peer is taken as it is.
    expect(secured.authorized).toBe(false);
  });

  it('fails like a refused connection when the listener is plain TCP', async () => {
    const port = await plainServer((s) => {
      s.on('error', () => {});
      s.on('data', () => s.write('not tls\r\n'));
    });
    const { socket, ready: event } = dialDccPeer('127.0.0.1', port, true);
    sockets.push(socket);
    // OpenSSL's words for a reply that was never a ServerHello.
    await expect(ready(socket, event)).rejects.toThrow(/SSL|TLS|version/i);
  });

  it('keeps the anonymous suites after the defaults, not instead of them', () => {
    const list = DCC_DIAL_CIPHERS.split(':');
    expect(list).not.toContain('!aNULL');
    expect(list.indexOf('aNULL')).toBeGreaterThan(list.indexOf('HIGH'));
    expect(list.at(-1)).toBe('@SECLEVEL=0');
  });
});

describe('secureAcceptedDccSocket', () => {
  async function acceptOne(): Promise<{ port: number; secured: Promise<tls.TLSSocket> }> {
    const context = await dccSecureContext();
    let onSecured!: (p: Promise<tls.TLSSocket>) => void;
    const secured = new Promise<Promise<tls.TLSSocket>>((r) => {
      onSecured = r;
    });
    const port = await plainServer((sock) => {
      sock.on('error', () => {});
      onSecured(secureAcceptedDccSocket(sock, context, 300));
    });
    return { port, secured: secured.then((p) => p) };
  }

  it('is the TLS server for a KVIrc client, and resolves once the handshake is done', async () => {
    const { port, secured } = await acceptOne();
    const client = await tlsDial(port);
    sockets.push(client);
    const ours = await secured;
    sockets.push(ours);
    expect(ours).toBeInstanceOf(tls.TLSSocket);
    // Our side has a certificate, so KVIrc's client gets an authenticated
    // suite even though its list allows the anonymous ones.
    expect(client.getCipher().name).not.toMatch(/^(ADH|AECDH)-/);
    expect(await echoOnce(client, ours, 'hello\r\n')).toBe('hello\r\n');
    expect(await echoOnce(ours, client, 'back\r\n')).toBe('back\r\n');
  });

  it('rejects a peer that connects and never starts a handshake', async () => {
    const { port, secured } = await acceptOne();
    const client = net.connect({ host: '127.0.0.1', port });
    sockets.push(client);
    await expect(secured).rejects.toThrow(/never completed the TLS handshake/);
  });

  it('rejects a peer that talks plaintext', async () => {
    const { port, secured } = await acceptOne();
    const client = net.connect({ host: '127.0.0.1', port }, () => client.write('hello\r\n'));
    client.on('error', () => {});
    sockets.push(client);
    await expect(secured).rejects.toThrow(/TLS handshake failed/);
  });

  it('rejects a peer that hangs up mid-handshake', async () => {
    const { port, secured } = await acceptOne();
    const client = net.connect({ host: '127.0.0.1', port }, () => client.destroy());
    sockets.push(client);
    await expect(secured).rejects.toThrow(/disconnected during the TLS handshake/);
  });
});

// The connected line names the suite, as KVIrc's does — the one fact about
// the TLS worth a line, since nothing verified the other side.
describe('describeDccTls', () => {
  it('names the protocol and cipher of a TLS socket once the handshake is done', async () => {
    const peer = await startTlsPeer({ anonymous: true });
    peers.push(peer);
    const { socket, ready: event } = dialDccPeer('127.0.0.1', peer.port, true);
    sockets.push(socket);
    await ready(socket, event);
    expect(describeDccTls(socket)).toMatch(/^ \(TLSv1\.2, [A-Z0-9_-]+\)$/);
  });

  it('is empty for a plain socket', async () => {
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { socket, ready: event } = dialDccPeer(
      '127.0.0.1',
      (server.address() as net.AddressInfo).port,
      false,
    );
    sockets.push(socket);
    await ready(socket, event);
    expect(describeDccTls(socket)).toBe('');
  });
});
