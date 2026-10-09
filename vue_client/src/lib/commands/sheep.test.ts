// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseSheepCommand } from './sheep.js';

describe('parseSheepCommand', () => {
  it('spawns a random-colored sheep on no argument and the spawn synonyms', () => {
    for (const s of ['', '   ', 'on', 'add', 'more', 'Spawn', 'random', 'add random']) {
      expect(parseSheepCommand(s)).toEqual({ kind: 'spawn', color: 'random' });
    }
  });

  it('spawns a sheep of a named color, with or without a verb', () => {
    expect(parseSheepCommand('blue')).toEqual({ kind: 'spawn', color: 'blue' });
    expect(parseSheepCommand('add Pink')).toEqual({ kind: 'spawn', color: 'pink' });
    const bad = parseSheepCommand('add plaid');
    expect(bad.kind).toBe('error');
    expect(bad.kind === 'error' && bad.message).toContain('no plaid sheep');
  });

  it('shoos the newest sheep, or all of them', () => {
    for (const s of ['off', 'kill', 'bye', 'SHOO']) {
      expect(parseSheepCommand(s)).toEqual({ kind: 'off', all: false });
    }
    expect(parseSheepCommand('off all')).toEqual({ kind: 'off', all: true });
    expect(parseSheepCommand('off everyone')).toEqual({ kind: 'off', all: true });
    expect(parseSheepCommand('off rick').kind).toBe('error');
  });

  it('lists the flock', () => {
    expect(parseSheepCommand('list')).toEqual({ kind: 'list' });
    expect(parseSheepCommand('who')).toEqual({ kind: 'list' });
  });

  it('parses sounds and scale, reporting when no value is given', () => {
    expect(parseSheepCommand('sounds off')).toEqual({ kind: 'sounds', on: false });
    expect(parseSheepCommand('sound ON')).toEqual({ kind: 'sounds', on: true });
    expect(parseSheepCommand('sounds')).toEqual({ kind: 'sounds', on: null });
    expect(parseSheepCommand('sounds loud').kind).toBe('error');
    expect(parseSheepCommand('scale 2')).toEqual({ kind: 'scale', scale: 2 });
    expect(parseSheepCommand('size 3')).toEqual({ kind: 'scale', scale: 3 });
    expect(parseSheepCommand('scale')).toEqual({ kind: 'scale', scale: null });
    expect(parseSheepCommand('scale 9').kind).toBe('error');
  });

  it('has about and help, and errors with usage on anything else', () => {
    expect(parseSheepCommand('about')).toEqual({ kind: 'about' });
    expect(parseSheepCommand('credits')).toEqual({ kind: 'about' });
    expect(parseSheepCommand('debug')).toEqual({ kind: 'debug' });
    expect(parseSheepCommand('help')).toEqual({ kind: 'help' });
    expect(parseSheepCommand('?')).toEqual({ kind: 'help' });
    const err = parseSheepCommand('dance');
    expect(err.kind).toBe('error');
    expect(err.kind === 'error' && err.message).toContain('usage: /sheep');
  });
});
