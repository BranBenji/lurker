// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The stdout record of an engine re-attach (#1069). The "Re-attached …" line in
// a network's server buffer never reaches `docker logs`, and after the 2.4.0
// upgrade (#1067) that was the one place to read how long the app had been
// away and how much it was handed. So each connection writes ONE line here
// when its catch-up ends (`live`), and a burst of them — every connection
// re-attaching after a restart or a lost link — writes one total once the last
// has caught up. Never per line: a 30-network cell would bury everything else.
//
// "The last" is read from a quiet spell, not from a count of what is open: the
// engine answers the CONNECTs one at a time, each with its replay, backlog and
// `live`, so a connection with little backlog can be live before its
// neighbours' `attached` has even been read. The burst ends once none is open
// and none has started or finished for QUIET_MS; one that starts inside that
// spell joins it. A catch-up still open after STALE_MS stops holding the total
// — every teardown is meant to close it, but one that never does must not
// silence the totals for the life of the process. It stays in its burst until
// the total, which counts it if it went live by then and says it is still
// catching up if it has not. Its own line is written whenever it goes live.
//
// The elapsed time runs from the first `attached`. The CONNECT before it is
// not a better start: until the engine answers, nothing says it will be an
// attach rather than a dial, and after a lost link it includes the wait for
// the link itself.
//
//   [engine] network 12: re-attached (away 42013ms, replay 180, backlog 3421, gap none)
//   [engine] 30 connections re-attached in 8.4s (replay 5400, backlog 102345, gap on 2)

export interface Reattach {
  networkId: number;
  detachedForMs: number;
  // Lines in the `attached` frame: the registration burst and the channel
  // state the engine replays into the fresh Client.
  replay: number;
  // Lines the engine reported lost (its `gap`), summed over every gap frame.
  // Zero: no gap.
  dropped: number;
}

const QUIET_MS = 1000;
const STALE_MS = 10 * 60_000;
let quietMs = QUIET_MS;
let staleMs = STALE_MS;

interface Burst {
  since: number;
  // When the last catch-up in it ended: the total's elapsed time.
  until: number;
  // When a catch-up last started or ended: the quiet spell runs from here.
  stirred: number;
  // The catch-ups between `attached` and `live`, with when each started. Only
  // ever non-empty while its burst is the current one.
  open: Map<Reattach, number>;
  // Open past STALE_MS: still this burst's, but no longer holding it open.
  stale: Set<Reattach>;
  conns: number;
  replay: number;
  backlog: number;
  gaps: number;
}

let burst: Burst | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function reattachStarted(
  networkId: number,
  detachedForMs: number,
  replay: number,
): Reattach {
  const r: Reattach = { networkId, detachedForMs, replay, dropped: 0 };
  const now = Date.now();
  burst ??= {
    since: now,
    until: now,
    stirred: now,
    open: new Map(),
    stale: new Set(),
    conns: 0,
    replay: 0,
    backlog: 0,
    gaps: 0,
  };
  burst.open.set(r, now);
  burst.stirred = now;
  arm();
  return r;
}

// The engine's `gap`: lines it could not keep while the app was away.
export function reattachGap(r: Reattach, dropped: number): void {
  r.dropped += dropped;
}

// `live`: the backlog is delivered. backlog = the lines it held.
export function reattachLive(r: Reattach, backlog: number): void {
  const gap = r.dropped > 0 ? `gap ${r.dropped} dropped` : 'gap none';
  console.log(
    `[engine] network ${r.networkId}: re-attached (away ${r.detachedForMs}ms, replay ${r.replay}, backlog ${backlog}, ${gap})`,
  );
  // Not in the current burst: it went stale, and the burst it was part of has
  // already been totalled without it.
  if (!burst || !(burst.open.delete(r) || burst.stale.delete(r))) return;
  burst.until = burst.stirred = Date.now();
  burst.conns++;
  burst.replay += r.replay;
  burst.backlog += backlog;
  if (r.dropped > 0) burst.gaps++;
}

// The catch-up ended without `live` — the socket closed, or another attach or
// dial replaced it. Nothing to report for it, but it no longer holds the total.
export function reattachAbandoned(r: Reattach): void {
  if (burst && (burst.open.delete(r) || burst.stale.delete(r))) burst.stirred = Date.now();
}

function arm(): void {
  if (timer || !burst) return;
  timer = setTimeout(tick, quietMs);
  timer.unref();
}

function tick(): void {
  timer = null;
  const b = burst;
  if (!b) return;
  const now = Date.now();
  for (const [r, at] of b.open) {
    if (now - at < staleMs) continue;
    b.open.delete(r);
    b.stale.add(r);
  }
  if (b.open.size > 0 || now - b.stirred < quietMs) {
    arm();
    return;
  }
  burst = null;
  // One connection's line already says everything a total would.
  if (b.conns + b.stale.size < 2) return;
  const secs = ((b.until - b.since) / 1000).toFixed(1);
  const stale = b.stale.size > 0 ? `, ${b.stale.size} still catching up` : '';
  console.log(
    `[engine] ${b.conns} connection${b.conns === 1 ? '' : 's'} re-attached in ${secs}s (replay ${b.replay}, backlog ${b.backlog}, gap on ${b.gaps}${stale})`,
  );
}

// Tests run the burst on a short clock, and start each from nothing.
export function configureReattachLogForTests(opts: { quietMs?: number; staleMs?: number }): void {
  if (timer) clearTimeout(timer);
  timer = null;
  burst = null;
  quietMs = opts.quietMs ?? QUIET_MS;
  staleMs = opts.staleMs ?? STALE_MS;
}
