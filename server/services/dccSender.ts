// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DCC SEND engine (#1086): one file on disk → one already-connected TCP
// socket. The mirror image of dccReceiver — the caller hands us a live socket
// (from a listener we opened for an active offer, or a dial-out for a passive
// one) plus the file path + size, and we stream the bytes with backpressure,
// reading the receiver's 4-byte cumulative ACKs so progress reflects what the
// peer has confirmed, not what we've queued. Deliberately IRC-free and DB-free:
// the caller owns the dcc_transfers row and the CTCP handshake; this just moves
// bytes and reports via callbacks, and never throws out of an async boundary.
//
// When is a send done? irssi (dcc-send.c:303-310) closes once the receiver's
// ACK equals what it sent, modulo 2^32. #528 counted any close after the last
// byte was queued as success, which also counts a receiver that died with a
// megabyte still in flight. Here:
//   - an ACK equal to the size (mod 2^32) after everything is sent is done;
//   - a receiver that closes having ACKed something must have ACKed all of it;
//   - a receiver that never ACKs at all is done once everything is sent and it
//     closes cleanly, since there is nothing else to judge by.
// ACKs count from the start of the file, including what a resume skipped
// (irssi dcc-resume.c:127 sets transfd = skipped = the resume position).

import fs from 'fs';
import net from 'net';

const ACK_MODULUS = 0x1_0000_0000;

export interface DccSendOptions {
  /** A socket that is ALREADY connected to the receiver. */
  socket: net.Socket;
  /** Absolute path to the file being sent. */
  filePath: string;
  /** Total file size in bytes (the receiver expects exactly this many). */
  size: number;
  /** Byte offset to start from — for a resume the receiver asked for; 0 = whole file. */
  startOffset?: number;
  /** Abort if the socket makes no progress this long. */
  idleTimeoutMs?: number;
  /** Bytes the receiver has confirmed, or, from a receiver that never ACKs, the
   *  bytes sent. The caller throttles DB/UI writes. */
  onProgress?: (confirmed: number) => void;
  /** Every byte sent and confirmed (see the header for "confirmed"). */
  onDone?: (size: number) => void;
  /** Failed (socket error, timeout, receiver closed early, file read error).
   *  `confirmed` is as onProgress reports it. */
  onError?: (err: Error, confirmed: number) => void;
}

export class DccSender {
  private readonly socket: net.Socket;
  private stream: fs.ReadStream | null = null;
  private sent: number;
  // The last ACK as the receiver sent it (a uint32), and what it means in
  // bytes from the start of the file. Null until the first one.
  private lastAck: number | null = null;
  private confirmed: number;
  private finishedReading = false;
  private settled = false;
  // The most onProgress has said, so it never goes back: the bytes sent come
  // first, until the first ACK, and ACKs trail what was sent.
  private reported: number;

  constructor(private readonly opts: DccSendOptions) {
    this.socket = opts.socket;
    this.sent = opts.startOffset ?? 0;
    this.confirmed = opts.startOffset ?? 0;
    this.reported = opts.startOffset ?? 0;
  }

  /** What the receiver has confirmed so far (see onProgress). */
  get bytesConfirmed(): number {
    return this.lastAck === null ? this.sent : this.confirmed;
  }

  start(): void {
    const { filePath, size, startOffset = 0, idleTimeoutMs = 120_000 } = this.opts;
    const sock = this.socket;
    // ⚠ Never switched off, not even while waiting for 'drain'. #528 disabled it
    // there, so a receiver that stopped reading (but kept its socket open) held
    // the send forever. A slow receiver still drains, and each write it takes
    // counts as activity.
    sock.setTimeout(idleTimeoutMs);
    sock.on('timeout', () => this.settle(new Error('DCC send timed out')));
    sock.on('error', (e) => this.settle(e));

    // The receiver streams 4-byte big-endian cumulative ACKs back. We don't
    // gate sending on them (fast send, like modern clients), but they are the
    // progress we show and how we know the receiver has all of it. Fragments
    // are coalesced by only reading whole 4-byte words.
    let ackBuf = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer | string) => {
      ackBuf = Buffer.concat([ackBuf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (ackBuf.length >= 4) {
        this.noteAck(ackBuf.readUInt32BE(0));
        ackBuf = ackBuf.subarray(4);
      }
      if (this.finishedReading && this.lastAck === size % ACK_MODULUS) this.settle(null);
    });

    sock.on('close', () => {
      if (this.settled) return;
      if (!this.finishedReading) {
        this.settle(new Error('receiver closed before the transfer finished'));
      } else if (this.lastAck !== null && this.lastAck !== size % ACK_MODULUS) {
        this.settle(
          new Error(`receiver closed having confirmed ${this.confirmed} of ${size} bytes`),
        );
      } else {
        this.settle(null);
      }
    });

    // Nothing left to send (an empty file, or a resume at the end): close, and
    // let the close above judge it.
    if (size <= startOffset) {
      this.finishedReading = true;
      sock.end();
      return;
    }

    this.stream = fs.createReadStream(filePath, { start: startOffset, end: size - 1 });
    this.stream.on('error', (e) => this.settle(e));
    this.stream.on('data', (chunk: Buffer | string) => {
      if (this.settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      this.sent += buf.length;
      if (this.lastAck === null) this.report(this.sent);
      // Backpressure: pause the file read while the socket buffer drains.
      if (!sock.write(buf)) {
        this.stream?.pause();
        sock.once('drain', () => {
          if (!this.settled) this.stream?.resume();
        });
      }
    });
    this.stream.on('end', () => {
      if (this.settled) return;
      this.finishedReading = true;
      if (this.sent !== size) {
        // The file shrank under us; the receiver can never get `size` bytes.
        this.settle(new Error(`the file ended at ${this.sent} of ${size} bytes`));
        return;
      }
      // Our FIN after the last byte. A receiver that never ACKs may be waiting
      // for it; one that ACKs can still send its last ACK into the half-open
      // socket, and the data handler above completes on it.
      sock.end();
    });
  }

  private noteAck(ack: number): void {
    this.lastAck = ack;
    // The ACK is the low 32 bits of a count that can pass 4 GiB. The count it
    // stands for is the largest one at or below what we've sent with those low
    // bits; never below the resume point or backwards.
    const back = (((this.sent - ack) % ACK_MODULUS) + ACK_MODULUS) % ACK_MODULUS;
    const abs = this.sent - back;
    if (abs > this.confirmed) {
      this.confirmed = abs;
      this.report(abs);
    }
  }

  private report(n: number): void {
    if (n <= this.reported) return;
    this.reported = n;
    this.opts.onProgress?.(n);
  }

  /** Abort an in-flight send; surfaces as an error to the caller. */
  cancel(): void {
    this.settle(new Error('cancelled'));
  }

  private settle(err: Error | null): void {
    if (this.settled) return;
    this.settled = true;
    try {
      this.stream?.destroy();
    } catch {
      /* already gone */
    }
    // Done means the receiver has every byte (or closed already), so there is
    // nothing left to flush either way.
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    if (err) this.opts.onError?.(err, this.bytesConfirmed);
    else this.opts.onDone?.(this.opts.size);
  }
}
