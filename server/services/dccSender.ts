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
// (irssi dcc-resume.c:127 sets transfd = skipped = the resume position), and
// every receiver that ACKs does it that way (HexChat, WeeChat, KVIrc, HexDroid,
// halloy). An ACK is credited only up to what we have sent, so one claiming
// the whole file early completes nothing.
//
// When to close: irssi, HexChat and KVIrc senders wait for the final ACK, and
// so do we, for a while, before our FIN. irssi and KVIrc receivers only close
// on EOF; through znc's bouncedcc, a FIN of ours tears down the user's side
// before their last ACK is relayed. A receiver that has never ACKed gets the
// FIN after a short wait, since it may be waiting for it: short, not none,
// because a small file is read to its end before the first ACK can arrive.

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
  /** With everything sent, how long to wait for a receiver that ACKs to
   *  confirm it all before we close our side. */
  finalAckGraceMs?: number;
  /** With everything sent and no ACK yet, how long to wait for one before
   *  taking the receiver for one that never ACKs. */
  firstAckWaitMs?: number;
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
  // Whether the receiver ACKs at all, and the most of the file it has
  // confirmed, in bytes from its start.
  private acks = false;
  private confirmed: number;
  private grace: ReturnType<typeof setTimeout> | null = null;
  // Bytes still in our socket's buffer when the receiver hung up: for one that
  // never ACKs, the only sign it left before it had everything.
  private unflushedAtEnd = 0;
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
    return this.acks ? this.confirmed : this.sent;
  }

  start(): void {
    const {
      filePath,
      size,
      startOffset = 0,
      idleTimeoutMs = 120_000,
      finalAckGraceMs = 30_000,
      firstAckWaitMs = 5_000,
    } = this.opts;
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
      if (this.finishedReading && this.confirmed === size) this.settle(null);
    });

    sock.on('end', () => {
      this.unflushedAtEnd = sock.writableLength;
    });
    sock.on('close', () => {
      if (this.settled) return;
      if (!this.finishedReading) {
        this.settle(new Error('receiver closed before the transfer finished'));
      } else if (this.acks && this.confirmed !== size) {
        this.settle(
          new Error(`receiver closed having confirmed ${this.confirmed} of ${size} bytes`),
        );
      } else if (!this.acks && this.unflushedAtEnd > 0) {
        this.settle(new Error('receiver closed before the transfer finished'));
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
      if (!this.acks) this.report(this.sent);
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
      // The final ACK can beat the end of our read.
      if (this.confirmed === size) {
        this.settle(null);
        return;
      }
      // A receiver that ACKs: its last one completes the send in the data
      // handler above, and the FIN waits for it (see the header). One that
      // never ACKs may be waiting for the FIN.
      const fin = (): void => {
        if (!this.settled) sock.end();
      };
      const firstWait = Math.min(firstAckWaitMs, finalAckGraceMs);
      this.grace = setTimeout(() => {
        if (!this.acks) fin();
        else this.grace = setTimeout(fin, finalAckGraceMs - firstWait);
      }, firstWait);
    });
  }

  private noteAck(ack: number): void {
    this.acks = true;
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
    if (this.grace) clearTimeout(this.grace);
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
