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

  it('returns nothing for a cap of zero', () => {
    expect(capText('abc', 0)).toBe('');
  });
});
