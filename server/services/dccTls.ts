// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// TLS for DCC (#1157): KVIrc's secure DCC (`SCHAT`, `SSEND`) is ordinary DCC
// with the connection wrapped in TLS, where whoever listens is the TLS server
// and whoever connects is the client (DccMarshal.cpp:568). Nothing about the
// peer is verified — there is no spec and no trust model, only encryption
// against a passive listener — so this module owns the two things both halves
// of Lurker's DCC need: how a dial is wrapped and how an accepted socket is.
//
// ⚠⚠ KVIrc has no certificate by default. Its listener then offers only the
// anonymous Diffie-Hellman suites, at OpenSSL's `@SECLEVEL=0` (KviSSL.cpp:419:
// "ADH don't need a certificate, so we can use secure dcc without a cert"), and
// those suites exist only up to TLS 1.2. Three things follow for OUR dial, each
// of which a spike against a cert-less listener showed is necessary:
//   - Node's default cipher list ends in `!aNULL`, a PERMANENT exclusion that
//     a later `aNULL` cannot undo, so the list is rebuilt without it;
//   - `@SECLEVEL=0`, as at level 1 OpenSSL refuses the anonymous suites;
//   - TLS 1.2 as the ceiling: offering 1.3 to a cert-less OpenSSL server fails
//     the handshake outright ("no suitable signature algorithm") instead of
//     falling back.
// A listener of ours always has a certificate (the bouncer's self-signed pair,
// utils/bouncerCert.ts), so it keeps Node's defaults: KVIrc's client offers the
// certificate suites ahead of the anonymous ones (`ALL:…:+ADH:+AECDH`), ZNC's
// schat module dials with `HIGH`, and HexDroid with a stock client.

import fs from 'fs';
import net from 'net';
import tls from 'tls';

import { loadOrCreateSelfSignedCert } from '../utils/bouncerCert.js';

/** How long a peer gets to complete the TLS handshake once connected. */
export const DCC_TLS_HANDSHAKE_TIMEOUT_MS = 15_000;

/** The cipher list a secure DCC dial offers: Node's defaults with the
 *  anonymous suites allowed again (see the header). The anonymous suites come
 *  LAST, so a listener with a certificate still gets an authenticated suite. */
export const DCC_DIAL_CIPHERS = [
  ...tls.DEFAULT_CIPHERS.split(':').filter((c) => c !== '!aNULL'),
  'aNULL',
  '!eNULL',
  '@SECLEVEL=0',
].join(':');

let contextPromise: Promise<tls.SecureContext> | null = null;

/** The secure context our DCC listeners present: the instance's self-signed
 *  bouncer certificate, generated on first use and persisted beside the DB.
 *  Loaded once per process. */
export function dccSecureContext(): Promise<tls.SecureContext> {
  if (!contextPromise) {
    contextPromise = loadOrCreateSelfSignedCert().then(({ certPath, keyPath }) =>
      tls.createSecureContext({
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      }),
    );
    // A failed load (an unwritable data dir) is retried next time, not cached.
    contextPromise.catch(() => {
      contextPromise = null;
    });
  }
  return contextPromise;
}

/** Forget the cached context (tests redirect the data dir between files). */
export function resetDccSecureContext(): void {
  contextPromise = null;
}

/** The event a dialled DCC socket is ready on: a plain socket at `connect`, a
 *  TLS one only once the handshake is done. A TLSSocket emits `connect` too,
 *  when the TCP leg is up and before any byte is protected, so a caller that
 *  wrote at `connect` would hand the engine a socket mid-handshake. */
export type DccDialReady = 'connect' | 'secureConnect';

/** Dial a DCC peer, plain or over TLS (#1157). The caller waits on `ready`
 *  before treating the socket as connected, and handles `error` and `timeout`
 *  as for a plain socket: a failed handshake is an `error` like a refused
 *  connection. */
export function dialDccPeer(
  host: string,
  port: number,
  secure: boolean,
): { socket: net.Socket; ready: DccDialReady } {
  if (!secure) return { socket: net.connect({ host, port }), ready: 'connect' };
  const socket = tls.connect({
    host,
    port,
    ciphers: DCC_DIAL_CIPHERS,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    // Nothing is verified (see the header): the peer's certificate, when it
    // has one, is self-signed, and a cert-less KVIrc has none at all.
    rejectUnauthorized: false,
  });
  return { socket, ready: 'secureConnect' };
}

/**
 * Wrap a socket a DCC listener of ours just accepted as the TLS server side,
 * resolving once the handshake is done. The peer is the TLS client, as in
 * KVIrc (the dialler always is), and nothing about it is verified. Rejects
 * when the handshake fails or doesn't finish within `timeoutMs`; the socket
 * is destroyed either way. `secureContext` is resolved by the caller before
 * the listener binds, so the wrap is synchronous with the accept and no byte
 * of the ClientHello is read before the TLS layer is in place.
 */
export function secureAcceptedDccSocket(
  socket: net.Socket,
  secureContext: tls.SecureContext,
  timeoutMs = DCC_TLS_HANDSHAKE_TIMEOUT_MS,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secured = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext,
      requestCert: false,
      rejectUnauthorized: false,
    });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      secured.destroy();
      reject(new Error('the peer connected but never completed the TLS handshake'));
    }, timeoutMs);
    timer.unref?.();
    secured.once('secure', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(secured);
    });
    secured.once('error', (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      secured.destroy();
      reject(new Error(`TLS handshake failed — ${err.message}`));
    });
    // The peer hanging up mid-handshake: 'close' without 'secure' or 'error'.
    secured.once('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('the peer disconnected during the TLS handshake'));
    });
  });
}

/** " (TLSv1.2, ADH-AES256-GCM-SHA384)" for a TLS socket, for the line that says
 *  a secure chat connected — the suite is the one fact worth printing, since
 *  nothing verified the other side. Empty for a plain socket, or one whose
 *  handshake has not settled. */
export function describeDccTls(socket: net.Socket): string {
  if (!(socket instanceof tls.TLSSocket)) return '';
  const parts = [socket.getProtocol(), socket.getCipher()?.name].filter((p): p is string => !!p);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
