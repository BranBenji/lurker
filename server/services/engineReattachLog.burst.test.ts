// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// When a burst of engine re-attaches writes its total (#1069), on a fake
// clock. engineReattachLog.test.ts drives the real attach flow; this pins the
// burst's edges: what joins it, what ends it, and that nothing can hold it
// open for good.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  configureReattachLogForTests,
  reattachAbandoned,
  reattachGap,
  reattachLive,
  reattachStarted,
} from './engineReattachLog.js';

const QUIET_MS = 100;
const STALE_MS = 10_000;

let log: MockInstance<typeof console.log>;
const lines = () => log.mock.calls.map((c) => String(c[0]));
const totals = () => lines().filter((l) => /^\[engine\] \d+ connections? re-attached in /.test(l));

beforeEach(() => {
  vi.useFakeTimers();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  configureReattachLogForTests({ quietMs: QUIET_MS, staleMs: STALE_MS });
});

afterEach(() => {
  configureReattachLogForTests({});
  log.mockRestore();
  vi.useRealTimers();
});

describe('the re-attach burst total', () => {
  it('takes in a catch-up that starts after another is already live', () => {
    const a = reattachStarted(1, 5000, 10);
    reattachLive(a, 3);
    vi.advanceTimersByTime(QUIET_MS / 2);
    const b = reattachStarted(2, 5000, 12);
    reattachGap(b, 40);
    vi.advanceTimersByTime(QUIET_MS / 2);
    reattachLive(b, 7);
    expect(totals()).toEqual([]);
    vi.advanceTimersByTime(3 * QUIET_MS);
    expect(lines()).toEqual([
      '[engine] network 1: re-attached (away 5000ms, replay 10, backlog 3, gap none)',
      '[engine] network 2: re-attached (away 5000ms, replay 12, backlog 7, gap 40 dropped)',
      '[engine] 2 connections re-attached in 0.1s (replay 22, backlog 10, gap on 1)',
    ]);
  });

  it('writes no total for a lone re-attach, nor for one after the quiet spell', () => {
    reattachLive(reattachStarted(1, 0, 10), 0);
    vi.advanceTimersByTime(3 * QUIET_MS);
    reattachLive(reattachStarted(2, 0, 10), 0);
    vi.advanceTimersByTime(3 * QUIET_MS);
    expect(lines()).toHaveLength(2);
    expect(totals()).toEqual([]);
  });

  it('does not count an abandoned catch-up, and does not wait for it', () => {
    const a = reattachStarted(1, 0, 10);
    const b = reattachStarted(2, 0, 10);
    const c = reattachStarted(3, 0, 10);
    reattachLive(a, 1);
    reattachAbandoned(b);
    reattachLive(c, 2);
    vi.advanceTimersByTime(3 * QUIET_MS);
    expect(totals()).toEqual([
      '[engine] 2 connections re-attached in 0.0s (replay 20, backlog 3, gap on 0)',
    ]);
  });

  it('a catch-up that never ends stops holding the total, and the next burst still gets one', () => {
    const a = reattachStarted(1, 0, 10);
    const stuck = reattachStarted(2, 0, 10);
    reattachLive(a, 4);
    vi.advanceTimersByTime(STALE_MS / 2);
    expect(totals()).toEqual([]);
    vi.advanceTimersByTime(STALE_MS);
    expect(totals()).toEqual([
      '[engine] 1 connection re-attached in 0.0s (replay 10, backlog 4, gap on 0, 1 still catching up)',
    ]);

    // Nothing left over: the next burst is its own.
    log.mockClear();
    const c = reattachStarted(3, 0, 10);
    const d = reattachStarted(4, 0, 10);
    reattachLive(c, 1);
    reattachLive(d, 1);
    vi.advanceTimersByTime(3 * QUIET_MS);
    expect(totals()).toEqual([
      '[engine] 2 connections re-attached in 0.0s (replay 20, backlog 2, gap on 0)',
    ]);

    // And should the stuck one ever go live, it still writes its own line,
    // into no one's total.
    log.mockClear();
    reattachLive(stuck, 9);
    vi.advanceTimersByTime(3 * QUIET_MS);
    expect(lines()).toEqual([
      '[engine] network 2: re-attached (away 0ms, replay 10, backlog 9, gap none)',
    ]);
  });
});
