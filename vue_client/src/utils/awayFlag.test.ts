// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseAwayFlag } from './awayFlag.js';

describe('parseAwayFlag', () => {
  it('takes a leading -all or -one, and leaves the message', () => {
    expect(parseAwayFlag('-all lunch')).toEqual({ all: true, rest: 'lunch' });
    expect(parseAwayFlag('-one lunch break')).toEqual({ all: false, rest: 'lunch break' });
    expect(parseAwayFlag('-ALL')).toEqual({ all: true, rest: '' });
  });

  it('leaves the scope to the setting without a flag', () => {
    expect(parseAwayFlag('lunch')).toEqual({ all: undefined, rest: 'lunch' });
    expect(parseAwayFlag('')).toEqual({ all: undefined, rest: '' });
  });

  it('reads a flag only at the front, and only as a whole word', () => {
    expect(parseAwayFlag('back at -all hands')).toEqual({
      all: undefined,
      rest: 'back at -all hands',
    });
    expect(parseAwayFlag('-allnighter')).toEqual({ all: undefined, rest: '-allnighter' });
  });
});
