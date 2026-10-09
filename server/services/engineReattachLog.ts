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
// neighbours' `attached` has even been read. The burst ends BURST_QUIET_MS after
// a catch-up closes with none open; one that starts inside that spell joins it.
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

const BURST_QUIET_MS = 1000;

interface Burst {
  since: number;
  // When the last catch-up in it ended: the total's elapsed time.
  until: number;
  conns: number;
  replay: number;
  backlog: number;
  gaps: number;
}

// Catch-ups between `attached` and `live`.
const open = new Set<Reattach>();
let burst: Burst | null = null;
let quietTimer: ReturnType<typeof setTimeout> | null = null;

export function reattachStarted(
  networkId: number,
  detachedForMs: number,
  replay: number,
): Reattach {
  const r: Reattach = { networkId, detachedForMs, replay, dropped: 0 };
  open.add(r);
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = null;
  burst ??= { since: Date.now(), until: 0, conns: 0, replay: 0, backlog: 0, gaps: 0 };
  return r;
}

// `live`: the backlog is delivered. backlog = the lines it held.
export function reattachLive(r: Reattach, backlog: number): void {
  if (!open.delete(r)) return;
  const gap = r.dropped > 0 ? `gap ${r.dropped} dropped` : 'gap none';
  console.log(
    `[engine] network ${r.networkId}: re-attached (away ${r.detachedForMs}ms, replay ${r.replay}, backlog ${backlog}, ${gap})`,
  );
  if (burst) {
    burst.until = Date.now();
    burst.conns++;
    burst.replay += r.replay;
    burst.backlog += backlog;
    if (r.dropped > 0) burst.gaps++;
  }
  settle();
}

// The catch-up ended without `live` — the socket closed, or another attach or
// dial replaced it. Nothing to report for it, but it no longer holds the total.
export function reattachAbandoned(r: Reattach): void {
  if (open.delete(r)) settle();
}

function settle(): void {
  if (open.size > 0 || !burst || quietTimer) return;
  quietTimer = setTimeout(endBurst, BURST_QUIET_MS);
  quietTimer.unref();
}

function endBurst(): void {
  quietTimer = null;
  const b = burst;
  burst = null;
  // One connection's line already says everything a total would.
  if (!b || b.conns < 2) return;
  const secs = ((b.until - b.since) / 1000).toFixed(1);
  console.log(
    `[engine] ${b.conns} connections re-attached in ${secs}s (replay ${b.replay}, backlog ${b.backlog}, gap on ${b.gaps})`,
  );
}
