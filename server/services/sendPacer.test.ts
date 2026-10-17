// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The per-connection outbound pacer (#1149): irssi's long-line rule, in order.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SendPacer, penaltyMs } from './sendPacer.js';

const LONG = `PRIVMSG #c :${'x'.repeat(284)}`; // 298 bytes with CRLF: 4 s
const GAP = 4000;

describe('penaltyMs', () => {
  it('is free under 100 bytes, then 2 s plus 1 s per 100', () => {
    expect(penaltyMs(99)).toBe(0);
    expect(penaltyMs(100)).toBe(3000);
    expect(penaltyMs(298)).toBe(4000);
    expect(penaltyMs(512)).toBe(7000);
  });
});

describe('SendPacer', () => {
  let sent: string[];
  let ready: boolean;
  let pacer: SendPacer;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    sent = [];
    ready = true;
    pacer = new SendPacer({ send: (l) => sent.push(l), ready: () => ready, maxKeyed: 2 });
  });
  afterEach(() => {
    pacer.drop();
    vi.useRealTimers();
  });

  it('sends a long line at once, and holds the next for its penalty', () => {
    pacer.write(LONG);
    pacer.write('PRIVMSG #c :two');
    expect(sent).toEqual([LONG]);
    vi.advanceTimersByTime(GAP - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([LONG, 'PRIVMSG #c :two']);
  });

  it('keeps order: a short line waits behind a long one', () => {
    pacer.write(LONG);
    pacer.write(LONG);
    pacer.write('PRIVMSG #c :short');
    vi.advanceTimersByTime(GAP);
    expect(sent).toEqual([LONG, LONG]);
    vi.advanceTimersByTime(GAP);
    expect(sent).toEqual([LONG, LONG, 'PRIVMSG #c :short']);
  });

  it('sends short lines back to back', () => {
    pacer.write('PRIVMSG #c :a');
    pacer.write('PRIVMSG #c :b');
    expect(sent).toEqual(['PRIVMSG #c :a', 'PRIVMSG #c :b']);
  });

  it('lets PING, PONG and QUIT past a wait', () => {
    pacer.write(LONG);
    pacer.write('PRIVMSG #c :held');
    pacer.write('PONG :srv');
    pacer.write('@label=1 PING lurker-lag-1');
    pacer.write('QUIT :bye');
    expect(sent).toEqual([LONG, 'PONG :srv', '@label=1 PING lurker-lag-1', 'QUIT :bye']);
  });

  it('sends everything at once before registration', () => {
    ready = false;
    pacer.write(LONG);
    pacer.write(LONG);
    expect(sent).toEqual([LONG, LONG]);
  });

  it('holds the queue while the connection is down, and sends it on resume', () => {
    pacer.write(LONG);
    pacer.write('PRIVMSG #c :held');
    ready = false;
    vi.advanceTimersByTime(GAP);
    expect(sent).toEqual([LONG]);
    ready = true;
    pacer.resume();
    expect(sent).toEqual([LONG, 'PRIVMSG #c :held']);
  });

  it('drops the queue and the wait for a new socket', () => {
    pacer.write(LONG);
    pacer.write('PRIVMSG #c :stale');
    pacer.drop();
    vi.advanceTimersByTime(GAP);
    expect(sent).toEqual([LONG]);
    pacer.write('PRIVMSG #c :fresh');
    expect(sent).toEqual([LONG, 'PRIVMSG #c :fresh']);
  });

  it('replaces a queued keyed line in place, and caps how many wait', () => {
    pacer.write(LONG);
    expect(pacer.write('NOTICE bob :old', 'bob KEYRSP c=#x')).toBe(true);
    expect(pacer.write('NOTICE carol :c', 'carol KEYRSP c=#x')).toBe(true);
    expect(pacer.write('NOTICE bob :new', 'bob KEYRSP c=#x')).toBe(true);
    expect(pacer.write('NOTICE dave :d', 'dave KEYRSP c=#x')).toBe(false);
    // Unkeyed lines are never refused.
    expect(pacer.write('PRIVMSG #c :mine')).toBe(true);
    vi.advanceTimersByTime(GAP);
    expect(sent).toEqual([LONG, 'NOTICE bob :new', 'NOTICE carol :c', 'PRIVMSG #c :mine']);
  });
});
