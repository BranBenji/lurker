// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The outbound queue of one IRC connection (#1149). Every line Lurker writes
// to the server goes through here, in order, and waits when the server would
// otherwise stop reading us.
//
// What a server charges: ircu and IRCnet's ircd advance a per-client clock by
// a couple of seconds plus a second per hundred-odd bytes for every line, read
// the client while that clock is less than ten seconds ahead of real time, and
// kill it ("Excess Flood") once what it sent meanwhile overflows a small input
// buffer. Lurker keeps the same clock (`since`): a line costs 2 s + 1 s per
// 100 bytes (irssi's constants, the pessimistic side of ircu's len/120, so an
// estimate that drifts drifts safe), goes at once while its charge still fits
// under 10 s, and waits for the charge to decay otherwise. HexChat paces every
// line the same way (server.c, tcp_send_queue); irssi sends five at once and
// then one per 2.2 s, WeeChat one per 2 s. Five short lines go at once, then
// one every 2 s; a REKEY burst or a long paste is spread out instead of killed.
//
// Not paced: anything written before registration (the registration burst,
// which an engine re-attach's transport swallows and a server gives grace),
// uncharged; and PING, PONG and QUIT, which waiting would only make wrong,
// charged since the server charges them.
//
// An item is a line, a thunk that makes its line(s) when its turn comes (a
// REKEY to a nick resolved at send time, an E2E message encrypted at send
// time), or a unit of lines that go back to back (a draft/multiline batch). A
// thunk may make further thunks, each run at its own turn. Every item can say
// what to do when it is sent (`onSent`: every timer that waits on a reply
// starts there, not at write), when it goes with its socket (`onDropped`: a
// user line reported as sent is reported again as not sent), and whether it
// is still wanted when its turn comes (`live`: a withdrawn DCC offer sends
// nothing).
//
// Order is absolute, with the bypasses above. There are no priorities: a REKEY
// is a NOTICE and the message that needs it a PRIVMSG, and the one must reach
// the wire before the other.

const BASE_COST_MS = 2000;
const COST_PER_100_BYTES_MS = 1000;
/** How far ahead of real time the server's clock may run before a line waits. */
export const BURST_BUDGET_MS = 10_000;
/** The most keyed items (handshake replies) allowed to wait at once. */
const DEFAULT_MAX_KEYED = 20;
const UNPACED = /^(?:@\S+ )?(?:PING|PONG|QUIT)\b/i;

/** What one line of `bytes` (CRLF included) advances the server's clock by.
 *  `LURKER_SEND_PACING=0` makes every line free: a test seam, for tests that
 *  send many lines through a real connection and would otherwise wait them
 *  out. */
export function lineCostMs(bytes: number): number {
  if (process.env.LURKER_SEND_PACING === '0') return 0;
  return BASE_COST_MS + Math.floor(bytes / 100) * COST_PER_100_BYTES_MS;
}

function costOf(line: string): number {
  return lineCostMs(Buffer.byteLength(line) + 2);
}

/** One line to send, with what to do once it has gone, or if it never does.
 *  `text` may be made when the line goes (a REKEY to the nick its peer has
 *  then); null then sends nothing. */
export interface Line {
  text: string | (() => string | null);
  onSent?: (at: number) => void;
  onDropped?: () => void;
}

/** What a thunk makes when its turn comes: lines, further thunks, or nothing. */
export type Built = string | Line | (() => Built) | Array<string | Line | (() => Built)> | null;

export interface WriteOptions {
  /** A keyed item replaces a queued item with the same key where it stands,
   *  and at most `maxKeyed` keyed items wait: a handshake reply to a peer. */
  key?: string;
  /** Asked when the line's turn comes; false sends nothing. */
  live?: () => boolean;
  /** Called right after the item's last line hits the socket. */
  onSent?: (at: number) => void;
  /** Called when the item is dropped with its socket, or over the keyed cap. */
  onDropped?: () => void;
}

export interface SendHandle {
  /** Take the item, and whatever it expanded to, out before it goes. True if
   *  any of it was still waiting. */
  cancel(): boolean;
}

export interface SendPacerOptions {
  /** Write one line to the socket now. */
  send: (line: string) => void;
  /** Whether the connection is registered and can take a line. */
  ready: () => boolean;
  /** How many items wait, whenever that changes (coalesced per tick). */
  onDepth?: (waiting: number) => void;
  /** Monotonic ms; injectable for tests. */
  now?: () => number;
  maxKeyed?: number;
}

interface Entry {
  text?: string;
  build?: () => Built;
  unit?: string[];
  key?: string;
  live?: () => boolean;
  onSent?: (at: number) => void;
  onDropped?: () => void;
  /** The item this one expanded from, for cancel(). */
  origin?: Entry;
}

// A line whose text is made when it goes, as a thunk making that line.
function lazyLine(line: Line): () => Built {
  const make = line.text as () => string | null;
  return () => {
    const text = make();
    return text === null ? null : { text, onSent: line.onSent };
  };
}

export class SendPacer {
  private readonly queue: Entry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private disposed = false;
  /** The server's clock for us, as far as we can tell: it reads us while this
   *  is less than BURST_BUDGET_MS ahead of now(). */
  private since = 0;
  private reportedDepth = 0;
  private depthReport: ReturnType<typeof setImmediate> | null = null;
  private readonly now: () => number;
  private readonly maxKeyed: number;

  constructor(private readonly opts: SendPacerOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.maxKeyed = opts.maxKeyed ?? DEFAULT_MAX_KEYED;
  }

  /**
   * Send `item` now, or queue it behind what is waiting. A string is the line;
   * a function makes the line(s) when the item's turn comes, and may return
   * `null` to send nothing after all.
   */
  write(item: string | (() => Built), opts: WriteOptions = {}): SendHandle {
    if (this.disposed) {
      opts.onDropped?.();
      return { cancel: () => false };
    }
    const entry: Entry = {
      ...(typeof item === 'string' ? { text: item } : { build: item }),
      key: opts.key,
      live: opts.live,
      onSent: opts.onSent,
      onDropped: opts.onDropped,
    };
    // Before registration, straight out and uncharged. The held lines, if any,
    // were written to a registered connection and wait for it to come back;
    // this is the registration burst, which must reach the transport now (an
    // engine re-attach swallows it), or a line the framework drops for want
    // of a socket, as it did before there was a queue.
    if (!this.opts.ready()) {
      this.sendAtOnce(entry);
      return { cancel: () => false };
    }
    // PING, PONG and QUIT too, since waiting would only make them late; the
    // server charges them, so they are charged.
    if (entry.text !== undefined && UNPACED.test(entry.text)) {
      this.sendNow(entry, true);
      return { cancel: () => false };
    }
    if (entry.key !== undefined) {
      const at = this.queue.findIndex((q) => q.key === entry.key);
      if (at !== -1) {
        this.queue[at] = entry;
        return this.handle(entry);
      }
      // The oldest keyed item goes to make room. Its onDropped may write
      // again, so the room is checked again, until there is some.
      let keyed = this.queue.filter((q) => q.key !== undefined);
      while (keyed.length >= this.maxKeyed && !this.disposed) {
        this.remove(keyed[0], true);
        keyed = this.queue.filter((q) => q.key !== undefined);
      }
      if (this.disposed) {
        opts.onDropped?.();
        return { cancel: () => false };
      }
    }
    this.queue.push(entry);
    this.noteDepth();
    this.drain();
    return this.handle(entry);
  }

  /** Send `lines` back to back, as one unit, and charge for all of them after. */
  unit(lines: string[], opts: WriteOptions = {}): SendHandle {
    if (this.disposed || lines.length === 0) {
      opts.onDropped?.();
      return { cancel: () => false };
    }
    const entry: Entry = { unit: lines, onSent: opts.onSent, onDropped: opts.onDropped };
    if (!this.opts.ready()) {
      this.sendAtOnce(entry);
      return { cancel: () => false };
    }
    this.queue.push(entry);
    this.noteDepth();
    this.drain();
    return this.handle(entry);
  }

  /** Items waiting. */
  get pending(): number {
    return this.queue.length;
  }

  /** Try again: the connection came (back) up. */
  resume(): void {
    this.drain();
  }

  /** A new socket: what waited was meant for the old one, and the server
   *  charges the new one from nothing. Every dropped item is told. */
  drop(): void {
    const dropped = this.queue.splice(0);
    this.since = 0;
    this.clearTimer();
    this.noteDepth();
    const told = new Set<Entry>();
    for (const entry of dropped) this.tellDropped(entry, told);
  }

  /** The connection is gone for good. Set before the items are told, so a
   *  write from an onDropped is dropped too, not sent. */
  dispose(): void {
    this.disposed = true;
    this.drop();
    if (this.depthReport) clearImmediate(this.depthReport);
    this.depthReport = null;
  }

  private handle(entry: Entry): SendHandle {
    return { cancel: () => this.remove(entry, false) };
  }

  // The item and everything it expanded to.
  private remove(entry: Entry, dropped: boolean): boolean {
    const taken: Entry[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (q === entry || this.rootOf(q) === entry) taken.unshift(...this.queue.splice(i, 1));
    }
    if (taken.length === 0) return false;
    this.noteDepth();
    if (dropped) {
      const told = new Set<Entry>();
      for (const q of taken) this.tellDropped(q, told);
    }
    return true;
  }

  private rootOf(entry: Entry): Entry {
    let root = entry;
    while (root.origin) root = root.origin;
    return root;
  }

  // A line's own onDropped, and the item it came from's, once each.
  private tellDropped(entry: Entry, told: Set<Entry>): void {
    if (!told.has(entry)) {
      told.add(entry);
      entry.onDropped?.();
    }
    for (let o = entry.origin; o; o = o.origin) {
      if (told.has(o)) continue;
      told.add(o);
      o.onDropped?.();
    }
  }

  private drain(): void {
    if (this.timer || this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        // Held until the connection is back; resume() picks it up.
        if (!this.opts.ready()) return;
        const head = this.queue[0];
        // The line goes when its own charge still fits under the budget: the
        // server's clock never runs more than BURST_BUDGET_MS ahead of real
        // time by our count. A thunk is run once the shortest line would fit,
        // so what it builds is as fresh as it can be; a unit is admitted on
        // its first line and goes whole.
        const ahead = this.since - this.now();
        const cost = head.build ? BASE_COST_MS : costOf(head.unit ? head.unit[0] : head.text!);
        const over = ahead + cost - BURST_BUDGET_MS;
        if (over > 0) {
          this.schedule(over);
          return;
        }
        this.queue.shift();
        if (head.build) {
          this.expand(head);
          continue;
        }
        this.noteDepth();
        if (head.live && !head.live()) continue;
        if (head.unit) this.sendUnit(head);
        else this.sendNow(head, true);
      }
    } finally {
      this.draining = false;
    }
  }

  // A thunk's items take its place at the head, each paced on its own. The
  // item's own onSent follows its last line; its onDropped fires once if any
  // of them is dropped (tellDropped); cancel() takes them all (remove).
  private expand(entry: Entry): void {
    let built: Built;
    try {
      built = entry.build!();
    } catch (err) {
      console.warn('[irc] send: an item failed to build and was skipped:', err);
      built = null;
    }
    const items = built === null ? [] : Array.isArray(built) ? built : [built];
    if (items.length === 0) {
      this.noteDepth();
      return;
    }
    const last = items.length - 1;
    const expanded: Entry[] = items.map((item, i) => {
      const own: Entry =
        typeof item === 'function'
          ? { build: item }
          : typeof item === 'string'
            ? { text: item }
            : typeof item.text === 'function'
              ? { build: lazyLine(item), onDropped: item.onDropped }
              : { text: item.text, onSent: item.onSent, onDropped: item.onDropped };
      own.origin = entry;
      if (i === last && entry.onSent) {
        const sent = own.onSent;
        own.onSent = (at) => {
          sent?.(at);
          entry.onSent!(at);
        };
      }
      return own;
    });
    this.queue.unshift(...expanded);
    this.noteDepth();
  }

  // Past the queue, uncharged: a line written before registration.
  private sendAtOnce(entry: Entry): void {
    if (entry.unit) {
      for (const line of entry.unit) this.opts.send(line);
      entry.onSent?.(this.now());
      return;
    }
    if (!entry.build) {
      this.sendNow(entry, false);
      return;
    }
    let built: Built;
    try {
      built = entry.build();
    } catch (err) {
      console.warn('[irc] send: an item failed to build and was skipped:', err);
      return;
    }
    const items = built === null ? [] : Array.isArray(built) ? built : [built];
    for (const item of items) {
      if (typeof item === 'function') this.sendAtOnce({ build: item });
      else if (typeof item === 'string') this.sendNow({ text: item }, false);
      else if (typeof item.text === 'function') this.sendAtOnce({ build: lazyLine(item) });
      else this.sendNow({ text: item.text, onSent: item.onSent }, false);
    }
    if (items.length) entry.onSent?.(this.now());
  }

  private sendNow(entry: Entry, charge: boolean): void {
    const text = entry.text!;
    this.opts.send(text);
    const at = this.now();
    if (charge) this.charge(costOf(text), at);
    entry.onSent?.(at);
  }

  private sendUnit(entry: Entry): void {
    let cost = 0;
    for (const line of entry.unit!) {
      this.opts.send(line);
      cost += costOf(line);
    }
    const at = this.now();
    this.charge(cost, at);
    entry.onSent?.(at);
  }

  private charge(cost: number, at: number): void {
    this.since = Math.max(this.since, at) + cost;
  }

  private schedule(wait: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // Depth changes with every line; report once per tick, and only a change.
  private noteDepth(): void {
    if (!this.opts.onDepth || this.depthReport) return;
    this.depthReport = setImmediate(() => {
      this.depthReport = null;
      const depth = this.pending;
      if (depth === this.reportedDepth) return;
      this.reportedDepth = depth;
      this.opts.onDepth?.(depth);
    });
  }
}
