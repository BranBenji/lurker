// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { capText } from './capText.js';

describe('capText', () => {
  it('leaves text within the cap alone', () => {
    expect(capText('ab😀', 4)).toBe('ab😀');
    expect(capText('', 4)).toBe('');
  });

  it('cuts plain text where slice would', () => {
    expect(capText('abcdef', 3)).toBe('abc');
  });

  it('steps back over an emoji the cap would split', () => {
    // 'ab😀'.slice(0, 3) is 'ab\ud83d'.
    expect(capText('ab😀cd', 3)).toBe('ab');
    expect(JSON.stringify(capText('ab😀cd', 3))).toBe('"ab"');
  });

  it('keeps an emoji that ends exactly at the cap', () => {
    expect(capText('ab😀cd', 4)).toBe('ab😀');
  });

  it('keeps a flag whole rather than one of its letters', () => {
    expect(capText('ab🇺🇸', 5)).toBe('ab');
  });

  it('drops a ZWJ sequence whole rather than leaving a dangling joiner', () => {
    const family = '👨‍👩‍👧';
    expect(capText(`ab${family}`, 2 + family.length - 1)).toBe('ab');
  });

  it('drops a character whose combining mark falls past the cap', () => {
    // 'e' fits, but the accent after it would be cut off.
    expect(capText('abé', 3)).toBe('ab');
    // A skin tone is itself two units, past a cut that lands right after the hand.
    expect(capText('ab👋🏽', 4)).toBe('ab');
  });

  it('cuts inside a grapheme longer than the whole cap, between code points', () => {
    expect(capText('a' + '́'.repeat(10), 4)).toBe('a' + '́'.repeat(3));
    expect(capText('😀́́', 1)).toBe('');
  });

  it('returns nothing for a cap of zero', () => {
    expect(capText('abc', 0)).toBe('');
  });
});
