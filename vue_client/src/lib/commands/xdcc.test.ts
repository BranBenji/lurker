// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { parseXdccCommand, XDCC_USAGE } from './xdcc.js';

describe('parseXdccCommand', () => {
  it("speaks EasyXdcc's add verbs", () => {
    expect(parseXdccCommand('add Bot 31')).toEqual({ kind: 'add', bot: 'Bot', packs: [31] });
    expect(parseXdccCommand('ADD Bot #31')).toEqual({ kind: 'add', bot: 'Bot', packs: [31] });
    expect(parseXdccCommand('addl Bot 29 32')).toEqual({
      kind: 'add',
      bot: 'Bot',
      packs: [29, 30, 31, 32],
    });
    // Backwards is the same range.
    expect(parseXdccCommand('addl Bot 32 30').kind === 'add').toBe(true);
    expect(parseXdccCommand('addm Bot 29 #31 35 31')).toEqual({
      kind: 'add',
      bot: 'Bot',
      packs: [29, 31, 35],
    });
  });

  it('takes a range on add too', () => {
    expect(parseXdccCommand('add Bot #29-#31')).toEqual({
      kind: 'add',
      bot: 'Bot',
      packs: [29, 30, 31],
    });
  });

  it('removes packs, or a whole bot', () => {
    expect(parseXdccCommand('rmp Bot 3')).toEqual({ kind: 'remove', bot: 'Bot', packs: [3] });
    expect(parseXdccCommand('rmpl Bot 3 5')).toEqual({
      kind: 'remove',
      bot: 'Bot',
      packs: [3, 4, 5],
    });
    expect(parseXdccCommand('rmpm Bot 3 9')).toEqual({ kind: 'remove', bot: 'Bot', packs: [3, 9] });
    expect(parseXdccCommand('rmbot Bot')).toEqual({ kind: 'remove', bot: 'Bot', packs: null });
  });

  it('shows the queue, all of it or one bot', () => {
    expect(parseXdccCommand('')).toEqual({ kind: 'queue', bot: null });
    expect(parseXdccCommand('queue')).toEqual({ kind: 'queue', bot: null });
    expect(parseXdccCommand('queue Bot')).toEqual({ kind: 'queue', bot: 'Bot' });
  });

  it('refuses a channel as a bot, in any of its four sigils', () => {
    for (const chan of ['#room', '&room', '+room', '!room', 'bob,#room', '@#room']) {
      expect(parseXdccCommand(`add ${chan} 1`).kind).toBe('error');
    }
  });

  it('says what is wrong', () => {
    expect(parseXdccCommand('add Bot')).toEqual({
      kind: 'error',
      message: 'add needs a pack number',
    });
    expect(parseXdccCommand('add Bot 1 2')).toEqual({
      kind: 'error',
      message: 'add takes one pack; addm takes several',
    });
    expect(parseXdccCommand('addm Bot x')).toEqual({
      kind: 'error',
      message: 'addm "x" is not a pack number',
    });
    expect(parseXdccCommand('addl Bot 1')).toEqual({
      kind: 'error',
      message: 'addl needs <first> <last>',
    });
    expect(parseXdccCommand('addl Bot 1 100000')).toEqual({
      kind: 'error',
      message: 'addl at most 500 packs at a time',
    });
    // A huge range is refused before anything is built.
    expect(parseXdccCommand('add Bot 1-999999999')).toEqual({
      kind: 'error',
      message: 'add at most 500 packs at a time',
    });
    expect(parseXdccCommand('addm Bot 1-300 400-700')).toEqual({
      kind: 'error',
      message: 'addm at most 500 packs at a time',
    });
    expect(parseXdccCommand('start')).toEqual({ kind: 'error', message: XDCC_USAGE });
    expect(parseXdccCommand('add')).toEqual({ kind: 'error', message: 'add needs a bot nick' });
  });
});
