// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Outbound pacing for one IRC connection (#1149). Every line Lurker writes to
// the server goes through here, in order. IRCnet's ircd charges a second per
// 100 bytes against a ~1000-byte input buffer, so a few long lines back to
// back (RPE2E handshakes, encrypted chunks, a long paste) are "Excess Flood".
// After a line of 100 bytes or more, the next waits 2 s plus 1 s per 100
// bytes: irssi's rule for the same problem (irc_server_send_data). Short lines
// cost nothing, but wait their turn behind a long one so order holds (a REKEY
// before the message encrypted under it).
//
// Not paced: anything before registration (servers give a grace there, and
// WeeChat sends its connect burst at once too), and PING, PONG and QUIT, which
// would only be made wrong by waiting.
//
// Lurker's own bulk traffic is paced by the server's replies already (the
// restore walk, the connect scheduler); this is the floor under everything.

const PENALTY_FREE_BYTES = 100;
const UNPACED = /^(?:@\S+ )?(?:PING|PONG|QUIT)\b/i;

/** How long the line holds back the next one, in ms (irssi's rule).
 *  `LURKER_SEND_PACING=0` turns it off: a test seam, for tests that send long
 *  lines through a real connection and would otherwise wait it out. */
export function penaltyMs(bytes: number): number {
  if (process.env.LURKER_SEND_PACING === '0') return 0;
  return bytes < PENALTY_FREE_BYTES ? 0 : (2 + Math.floor(bytes / 100)) * 1000;
}

interface Queued {
  line: string;
  key?: string;
}

export interface SendPacerOptions {
  /** Write one line to the socket now. */
  send: (line: string) => void;
  /** Whether the connection is registered and can take a line. */
  ready: () => boolean;
  /** Monotonic ms; injectable for tests. */
  now?: () => number;
  /** Most keyed lines (handshakes) allowed to wait at once. */
  maxKeyed?: number;
}

export class SendPacer {
  private readonly queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readyAt = 0;
  private readonly now: () => number;
  private readonly maxKeyed: number;

  constructor(private readonly opts: SendPacerOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.maxKeyed = opts.maxKeyed ?? 20;
  }

  /**
   * Send `line` now, or queue it behind what's waiting. A line with a `key`
   * replaces a queued one with the same key where it stands (a newer handshake
   * to the same peer for the same channel), and is refused, returning false,
   * when `maxKeyed` keyed lines already wait.
   */
  write(line: string, key?: string): boolean {
    if (!this.opts.ready() || UNPACED.test(line)) {
      this.opts.send(line);
      return true;
    }
    if (key !== undefined) {
      const at = this.queue.findIndex((q) => q.key === key);
      if (at !== -1) {
        this.queue[at] = { line, key };
        return true;
      }
      if (this.queue.filter((q) => q.key !== undefined).length >= this.maxKeyed) return false;
    }
    this.queue.push(key === undefined ? { line } : { line, key });
    this.drain();
    return true;
  }

  /** Lines waiting, for tests and logs. */
  get pending(): number {
    return this.queue.length;
  }

  /** Try again: the connection came (back) up. */
  resume(): void {
    this.drain();
  }

  /** A new socket: what was queued was meant for the old one, and the server
   *  charges the new one from nothing. */
  drop(): void {
    this.queue.length = 0;
    this.readyAt = 0;
    this.clearTimer();
  }

  private drain(): void {
    if (this.timer) return;
    while (this.queue.length) {
      // Held until the connection is back; resume() picks it up.
      if (!this.opts.ready()) return;
      const wait = this.readyAt - this.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.drain();
        }, wait);
        return;
      }
      const { line } = this.queue.shift()!;
      this.opts.send(line);
      const cost = penaltyMs(Buffer.byteLength(line) + 2); // + CRLF
      this.readyAt = cost ? this.now() + cost : 0;
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
