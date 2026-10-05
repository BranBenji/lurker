// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { textBudget, MIN_TEXT_BUDGET, ACTION_WRAPPER_BYTES } from './wireBudget.js';

describe('textBudget', () => {
  it('is what is left of 512 bytes once the network puts our prefix in front', () => {
    const line = (text: string) => `:alice!~alice@example.net PRIVMSG #room :${text}\r\n`;
    const budget = textBudget({
      nick: 'alice',
      userhostBytes: Buffer.byteLength('~alice@example.net'),
      command: 'PRIVMSG',
      target: '#room',
    });
    expect(Buffer.byteLength(line('x'.repeat(budget)))).toBe(512);
  });

  it('leaves a /me room for its \\x01ACTION … \\x01 wrapper', () => {
    const opts = { nick: 'alice', userhostBytes: 20, command: 'PRIVMSG', target: '#room' };
    expect(textBudget({ ...opts, action: true })).toBe(textBudget(opts) - ACTION_WRAPPER_BYTES);
    const body = 'x'.repeat(textBudget({ ...opts, action: true }));
    expect(Buffer.byteLength(`\x01ACTION ${body}\x01`)).toBe(textBudget(opts));
  });

  it('counts bytes, not characters, in the nick and target', () => {
    const ascii = textBudget({ nick: 'a', userhostBytes: 10, command: 'PRIVMSG', target: '#a' });
    const wide = textBudget({ nick: 'é', userhostBytes: 10, command: 'PRIVMSG', target: '#é' });
    expect(ascii - wide).toBe(2);
  });

  it('never goes below the floor, however long the prefix', () => {
    expect(
      textBudget({ nick: 'a', userhostBytes: 1_000_000_000, command: 'PRIVMSG', target: '#a' }),
    ).toBe(MIN_TEXT_BUDGET);
  });
});
