// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Peers for the secure DCC tests (#1157): a listener the way KVIrc listens,
// and a dial the way KVIrc and ZNC's schat dial. Two listener shapes matter:
// KVIrc with no certificate, which offers only the anonymous suites at
// OpenSSL's level 0 (KviSSL.cpp:419), and a peer with a self-signed certificate
// (KVIrc given one, ZNC's schat module). Lurker's own self-signed pair stands
// in for the latter.

import fs from 'fs';
import net from 'net';
import tls from 'tls';

import { loadOrCreateSelfSignedCert } from '../utils/bouncerCert.js';

/** KVIrc's cipher list once it has enabled the anonymous suites. */
export const KVIRC_CIPHERS =
  'ALL:!eNULL:!LOW:!EXP:!SSLv2:!SSLv3:!TLSv1:+ADH:+AECDH:@STRENGTH:@SECLEVEL=0';

export interface TlsPeer {
  port: number;
  /** The first connection, once its handshake is done. */
  socket: Promise<tls.TLSSocket>;
  close(): void;
}

/** A TLS listener that takes one connection. `anonymous`: no certificate, as
 *  KVIrc listens by default; otherwise Lurker's self-signed pair. */
export async function startTlsPeer(opts: { anonymous?: boolean } = {}): Promise<TlsPeer> {
  const context = opts.anonymous
    ? { ciphers: KVIRC_CIPHERS, dhparam: 'auto', minVersion: 'TLSv1.2' as const }
    : await selfSignedPair();
  let onSock!: (s: tls.TLSSocket) => void;
  const socket = new Promise<tls.TLSSocket>((r) => {
    onSock = r;
  });
  const server = tls.createServer(context, (sock) => {
    sock.on('error', () => {});
    onSock(sock);
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    socket,
    close: () => server.close(),
  };
}

/** Dial a listener of ours as a KVIrc client does: verifying nothing, with the
 *  anonymous suites allowed. Resolves once the handshake is done. */
export function tlsDial(port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(
      { host: '127.0.0.1', port, rejectUnauthorized: false, ciphers: KVIRC_CIPHERS },
      () => resolve(sock),
    );
    sock.once('error', reject);
  });
}

/** Lurker's self-signed certificate and key, as a TLS server takes them. */
export async function selfSignedPair(): Promise<{ cert: Buffer; key: Buffer }> {
  const { certPath, keyPath } = await loadOrCreateSelfSignedCert();
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}
