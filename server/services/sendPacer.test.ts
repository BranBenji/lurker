// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The per-connection outbound queue (#1149): the burst budget, order, the
// bypasses, thunks, units, barriers, cancel, onSent/onDropped, hold and drop.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SendPacer, lineCostMs, BURST_BUDGET_MS } from './sendPacer.js';

const SHORT = 'PRIVMSG #c :hi'; // 16 bytes with CRLF: 2 s
const LONG = `PRIVMSG #c :${'x'.repeat(284)}`; // 298 bytes with CRLF: 4 s

// Pacing is off for the suite (test-utils/setup.ts); this file is about it.
beforeEach(() => {
  process.env.LURKER_SEND_PACING = '1';
});
afterEach(() => {
  process.env.LURKER_SEND_PACING = '0';
});

describe('lineCostMs', () => {
  it('is 2 s plus 1 s per 100 bytes', () => {
    expect(lineCostMs(16)).toBe(2000);
    expect(lineCostMs(99)).toBe(2000);
    expect(lineCostMs(100)).toBe(3000);
    expect(lineCostMs(298)).toBe(4000);
    expect(lineCostMs(512)).toBe(7000);
  });

  it('is free with LURKER_SEND_PACING=0', () => {
    process.env.LURKER_SEND_PACING = '0';
    expect(lineCostMs(512)).toBe(0);
  });
});

describe('SendPacer', () => {
  let sent: string[];
  let ready: boolean;
  let depths: number[];
  let pacer: SendPacer;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'performance'],
    });
    sent = [];
    ready = true;
    depths = [];
    pacer = new SendPacer({
      send: (l) => sent.push(l),
      ready: () => ready,
      onDepth: (n) => depths.push(n),
      maxKeyed: 2,
    });
  });
  afterEach(() => {
    pacer.dispose();
    vi.useRealTimers();
  });

  describe('the budget', () => {
    it('sends five short lines at once, then one every 2 s', () => {
      for (let i = 0; i < 7; i++) pacer.write(`PRIVMSG #c :${i}`);
      expect(sent).toHaveLength(5);
      vi.advanceTimersByTime(1999);
      expect(sent).toHaveLength(5);
      vi.advanceTimersByTime(1);
      expect(sent).toHaveLength(6);
      vi.advanceTimersByTime(2000);
      expect(sent).toHaveLength(7);
    });

    it('charges long lines by their bytes', () => {
      for (let i = 0; i < 4; i++) pacer.write(LONG);
      // 4 s each: two fit under the 10 s budget, the third waits for the
      // charge to decay enough to take it.
      expect(sent).toHaveLength(2);
      vi.advanceTimersByTime(1999);
      expect(sent).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(sent).toHaveLength(3);
      vi.advanceTimersByTime(4000);
      expect(sent).toHaveLength(4);
    });

    it('lets the charge decay in real time', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      vi.advanceTimersByTime(BURST_BUDGET_MS);
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      expect(sent).toHaveLength(10);
    });

    it('keeps order: a short line waits behind a long one', () => {
      for (let i = 0; i < 3; i++) pacer.write(LONG);
      pacer.write(SHORT);
      expect(sent).toHaveLength(2);
      vi.advanceTimersByTime(2000);
      expect(sent).toEqual([LONG, LONG, LONG]);
      vi.advanceTimersByTime(1999);
      expect(sent).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(sent.at(-1)).toBe(SHORT);
    });
  });

  describe('bypasses', () => {
    it('lets PING, PONG and QUIT past a wait', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('PRIVMSG #c :held');
      pacer.write('PONG :srv');
      pacer.write('@label=1 PING lurker-lag-1');
      pacer.write('QUIT :bye');
      expect(sent.slice(5)).toEqual(['PONG :srv', '@label=1 PING lurker-lag-1', 'QUIT :bye']);
      expect(pacer.pending).toBe(1);
    });

    it('sends everything at once before registration, uncharged', () => {
      ready = false;
      for (let i = 0; i < 8; i++) pacer.write(LONG);
      expect(sent).toHaveLength(8);
      ready = true;
      pacer.write(SHORT);
      expect(sent).toHaveLength(9);
    });

    it('sends a thunk and a unit at once before registration too', () => {
      ready = false;
      const log: string[] = [];
      pacer.write(() => [{ text: 'NOTICE bob :a', onSent: () => log.push('a') }, 'NOTICE bob :b'], {
        onSent: () => log.push('item'),
      });
      pacer.unit(['BATCH +r', 'BATCH -r'], { onSent: () => log.push('unit') });
      expect(sent).toEqual(['NOTICE bob :a', 'NOTICE bob :b', 'BATCH +r', 'BATCH -r']);
      expect(log).toEqual(['a', 'item', 'unit']);
    });

    it('sends the registration burst past held lines', () => {
      pacer.write(SHORT);
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      ready = false;
      pacer.write('NICK me');
      expect(sent.at(-1)).toBe('NICK me');
      expect(pacer.pending).toBe(1);
    });
  });

  describe('hold and drop', () => {
    it('holds the queue while the connection is down, and sends it on resume', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('PRIVMSG #c :held');
      ready = false;
      vi.advanceTimersByTime(5000);
      expect(sent).toHaveLength(5);
      ready = true;
      pacer.resume();
      expect(sent.at(-1)).toBe('PRIVMSG #c :held');
    });

    it('drops the queue and the charge for a new socket, and tells each item', () => {
      const dropped: string[] = [];
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('PRIVMSG #c :stale', { onDropped: () => dropped.push('stale') });
      pacer.write(() => 'PRIVMSG #c :thunk', { onDropped: () => dropped.push('thunk') });
      pacer.drop();
      expect(dropped).toEqual(['stale', 'thunk']);
      vi.advanceTimersByTime(10_000);
      expect(sent).toHaveLength(5);
      pacer.write('PRIVMSG #c :fresh');
      expect(sent.at(-1)).toBe('PRIVMSG #c :fresh');
    });

    it('drops a write after dispose', () => {
      const dropped = vi.fn<() => void>();
      pacer.dispose();
      pacer.write(SHORT, { onDropped: dropped });
      expect(dropped).toHaveBeenCalledOnce();
      expect(sent).toEqual([]);
    });
  });

  describe('keyed items', () => {
    it('replaces a queued keyed line in place, and drops the oldest over the cap', () => {
      const dropped: string[] = [];
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('NOTICE bob :old', { key: 'bob', onDropped: () => dropped.push('bob') });
      pacer.write('NOTICE carol :c', { key: 'carol', onDropped: () => dropped.push('carol') });
      pacer.write('NOTICE bob :new', { key: 'bob', onDropped: () => dropped.push('bob') });
      pacer.write('PRIVMSG #c :mine');
      pacer.write('NOTICE dave :d', { key: 'dave' });
      expect(dropped).toEqual(['bob']);
      vi.advanceTimersByTime(20_000);
      expect(sent.slice(5)).toEqual(['NOTICE carol :c', 'PRIVMSG #c :mine', 'NOTICE dave :d']);
    });
  });

  describe('thunks', () => {
    it('makes the line when its turn comes', () => {
      let nick = 'bob';
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(() => `NOTICE ${nick} :hi`);
      nick = 'bob2';
      vi.advanceTimersByTime(2001);
      expect(sent.at(-1)).toBe('NOTICE bob2 :hi');
    });

    it('skips a thunk that returns null or throws, without charge', () => {
      pacer.write(() => null);
      pacer.write(() => {
        throw new Error('no');
      });
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      expect(sent).toHaveLength(5);
    });

    it('paces the lines a thunk expands to one by one, in order, with their callbacks', () => {
      const log: string[] = [];
      pacer.write(
        () => [
          { text: 'NOTICE bob :REKEY', onSent: () => log.push('rekey') },
          { text: LONG, onSent: () => log.push('chunk1') },
          { text: LONG, onSent: () => log.push('chunk2') },
          { text: LONG, onSent: () => log.push('chunk3') },
        ],
        { onSent: () => log.push('message') },
      );
      pacer.write(SHORT);
      // 2 + 4 + 4 = 10 s fit; the third chunk waits.
      expect(sent).toEqual(['NOTICE bob :REKEY', LONG, LONG]);
      expect(log).toEqual(['rekey', 'chunk1', 'chunk2']);
      vi.advanceTimersByTime(4000);
      expect(sent).toHaveLength(4);
      expect(log).toEqual(['rekey', 'chunk1', 'chunk2', 'chunk3', 'message']);
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe(SHORT);
    });

    it('tells a dropped thunk once, however many lines it expanded to', () => {
      const dropped = vi.fn<() => void>();
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(() => [LONG, LONG, LONG], { onDropped: dropped });
      vi.advanceTimersByTime(4000);
      expect(sent).toHaveLength(6);
      pacer.drop();
      expect(dropped).toHaveBeenCalledOnce();
    });
  });

  describe('units', () => {
    it('sends a unit back to back and charges for all of it after', () => {
      const batch = [
        'BATCH +r draft/multiline #c',
        `@batch=r ${LONG}`,
        `@batch=r ${LONG}`,
        'BATCH -r',
      ];
      pacer.unit(batch);
      pacer.write(SHORT);
      expect(sent).toEqual(batch);
      // 2 + 5 + 5 + 2 = 14 s charged: the short line fits once 6 s have gone.
      vi.advanceTimersByTime(5999);
      expect(sent).toHaveLength(4);
      vi.advanceTimersByTime(1);
      expect(sent.at(-1)).toBe(SHORT);
    });
  });

  describe('barriers', () => {
    it('holds what follows for ms after the line before it went', () => {
      pacer.write('JOIN #a');
      pacer.barrier(5000);
      pacer.write('JOIN #b');
      expect(sent).toEqual(['JOIN #a']);
      vi.advanceTimersByTime(4999);
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(['JOIN #a', 'JOIN #b']);
      expect(pacer.pending).toBe(0);
    });

    it('counts from its own creation when nothing went before it', () => {
      vi.advanceTimersByTime(1000);
      pacer.barrier(3000);
      pacer.write('JOIN #b');
      vi.advanceTimersByTime(2999);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(['JOIN #b']);
    });
  });

  describe('handles and callbacks', () => {
    it('cancels a waiting item, and not a sent one', () => {
      const h1 = pacer.write(SHORT);
      for (let i = 0; i < 4; i++) pacer.write(SHORT);
      const h2 = pacer.write('PRIVMSG #c :withdrawn');
      expect(h1.cancel()).toBe(false);
      expect(h2.cancel()).toBe(true);
      expect(h2.cancel()).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(sent).not.toContain('PRIVMSG #c :withdrawn');
    });

    it('calls onSent with the send time, not the write time', () => {
      const at: number[] = [];
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(SHORT, { onSent: (t) => at.push(t) });
      const wrote = performance.now();
      vi.advanceTimersByTime(2000);
      expect(at).toEqual([wrote + 2000]);
    });

    it('reports the depth once per tick, and only when it changes', () => {
      for (let i = 0; i < 8; i++) pacer.write(SHORT);
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([3]);
      vi.advanceTimersByTime(2000);
      expect(depths).toEqual([3, 2]);
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([3, 2]);
      pacer.drop();
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([3, 2, 0]);
    });
  });
});
