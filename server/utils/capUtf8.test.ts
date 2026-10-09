// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import { capUtf8, utf8Bytes } from './capUtf8.js';

describe('capUtf8', () => {
  it('leaves text within the budget alone', () => {
    expect(capUtf8('hello', 5)).toBe('hello');
    expect(capUtf8('漢字', 6)).toBe('漢字');
  });

  it('counts bytes, not UTF-16 units', () => {
    expect(capUtf8('漢字', 5)).toBe('漢');
    expect(capUtf8('😀😀', 7)).toBe('😀');
    expect(capUtf8('é', 1)).toBe('');
  });

  it('cuts between graphemes', () => {
    // A ZWJ family is one grapheme of 25 bytes.
    const family = '👨‍👩‍👧‍👦';
    expect(utf8Bytes(family)).toBe(25);
    expect(capUtf8('a' + family, 25)).toBe('a');
    expect(capUtf8('a' + family, 26)).toBe('a' + family);
    // A skin tone extends the hand before it.
    expect(capUtf8('a👋🏽', 5)).toBe('a');
  });

  it('cuts inside a grapheme that alone outruns the budget, between code points', () => {
    const piled = 'e' + '́'.repeat(10); // one grapheme, 21 bytes
    expect(capUtf8(piled, 5)).toBe('é́');
    // Never half a surrogate pair.
    expect(capUtf8('😀́', 3)).toBe('');
  });

  it('counts a lone surrogate as three bytes', () => {
    expect(utf8Bytes('\ud83d')).toBe(3);
    expect(capUtf8('\ud83d\ud83d', 5)).toBe('\ud83d');
  });

  it('returns nothing for a budget of zero or less', () => {
    expect(capUtf8('abc', 0)).toBe('');
    expect(capUtf8('abc', -4)).toBe('');
  });
});
