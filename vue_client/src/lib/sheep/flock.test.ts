// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { describeSheep, formatFlock, newFlockId, parseFlock } from './flock.js';

describe('flock entries', () => {
  it('round-trips through the setting value', () => {
    const entries = [
      { id: 'abc123', color: 'red' as const },
      { id: 'zz99', color: 'blue' as const },
    ];
    expect(formatFlock(entries)).toEqual(['abc123:red', 'zz99:blue']);
    expect(parseFlock(formatFlock(entries))).toEqual(entries);
  });

  it('drops malformed, unknown-color and duplicate entries, keeping order', () => {
    expect(
      parseFlock([
        'abc123:red',
        'nocolon',
        'abc123:blue', // duplicate id
        'x:green', // id too short
        'def456:plaid',
        42,
        'UPPER1:red',
        'ghi789:yellow:Rick Hendricks', // an older entry carried a name
      ]),
    ).toEqual([
      { id: 'abc123', color: 'red' },
      { id: 'ghi789', color: 'yellow' },
    ]);
    expect(parseFlock(undefined)).toEqual([]);
    expect(parseFlock('abc123:red')).toEqual([]);
  });

  it('describes a sheep by its pet name, or by color when it has none', () => {
    expect(describeSheep({ color: 'blue', name: 'Ben' })).toBe('Ben');
    expect(describeSheep({ color: 'blue' })).toBe('the blue sheep');
  });

  it('mints ids the parser accepts', () => {
    const id = newFlockId();
    expect(parseFlock([`${id}:pink`])).toEqual([{ id, color: 'pink' }]);
    expect(newFlockId(() => 0)).toBe('000000');
    expect(newFlockId(() => 0.999)).toBe('zzzzzz');
  });
});
