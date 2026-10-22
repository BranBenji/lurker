// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { tileIndex, tileUrl } from './avatarTiles.js';

describe('tileIndex', () => {
  it('is deterministic and inside the set', () => {
    const a = tileIndex('bob', 100);
    expect(a).toBe(tileIndex('bob', 100));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    for (const nick of ['a', 'Zed', 'someone_long_nick', 'ñandú', '[bracket]']) {
      const i = tileIndex(nick, 7);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(7);
    }
  });

  it('normalises the nick the way the nick colour does', () => {
    expect(tileIndex('Bob', 100)).toBe(tileIndex('bob', 100));
    expect(tileIndex('bob_', 100)).toBe(tileIndex('bob', 100));
    expect(tileIndex('bob|away', 100)).toBe(tileIndex('bob', 100));
    expect(tileIndex('_bob', 100)).toBe(tileIndex('_bob', 100));
    // Different stop characters, different trim.
    expect(tileIndex('bob-x', 100, '-')).toBe(tileIndex('bob', 100, '-'));
  });

  it('spreads nicks over the set', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(tileIndex(`nick${i}`, 32));
    expect(seen.size).toBe(32);
  });

  it('answers -1 when there is nothing to pick', () => {
    expect(tileIndex('', 10)).toBe(-1);
    expect(tileIndex(null, 10)).toBe(-1);
    expect(tileIndex('bob', 0)).toBe(-1);
    // A nick that is all stop characters keeps them, as the colour does.
    expect(tileIndex('_', 10)).toBeGreaterThanOrEqual(0);
  });
});

describe('tileUrl', () => {
  it('numbers tiles from 000', () => {
    expect(tileUrl('/avatars/default', 0, 'webp')).toBe('/avatars/default/000.webp');
    expect(tileUrl('/avatars/default/', 42, 'png')).toBe('/avatars/default/042.png');
    expect(tileUrl('/api/avatar-sets/7', 123, 'webp')).toBe('/api/avatar-sets/7/123.webp');
  });
});
