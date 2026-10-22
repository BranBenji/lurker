// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { parseAvatarsCommand } from './avatars.js';

describe('/avatars', () => {
  it('lists by default', () => {
    expect(parseAvatarsCommand('')).toEqual({ kind: 'list' });
    expect(parseAvatarsCommand('list')).toEqual({ kind: 'list' });
    expect(parseAvatarsCommand('LS')).toEqual({ kind: 'list' });
  });
  it('takes the rest of the line as the set name, quotes stripped', () => {
    expect(parseAvatarsCommand('use Bauhaus Blocks')).toEqual({
      kind: 'use',
      name: 'Bauhaus Blocks',
    });
    expect(parseAvatarsCommand('use "default"')).toEqual({ kind: 'use', name: 'default' });
    expect(parseAvatarsCommand('delete Old Set')).toEqual({ kind: 'delete', name: 'Old Set' });
    expect(parseAvatarsCommand('rm x')).toEqual({ kind: 'delete', name: 'x' });
  });
  it('says what is missing', () => {
    expect(parseAvatarsCommand('use')).toMatchObject({ kind: 'error' });
    expect(parseAvatarsCommand('frob')).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^usage/),
    });
  });
});
