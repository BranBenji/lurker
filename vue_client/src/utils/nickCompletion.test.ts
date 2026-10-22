// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { buildNickCandidates } from './nickCompletion.js';
// Display names (#607): `@bra` finds the user shown as "Brad Root", by the
// start of the name or of any word in it; the nick is what comes back.
describe('buildNickCandidates — display names', () => {
  const buf = {
    target: '#c',
    members: [{ nick: 'amiantos' }, { nick: 'carol' }, { nick: 'brad_' }],
    speakers: {},
  };
  const nameOf = (nick: string) => (nick === 'amiantos' ? 'Brad Root' : null);

  it('matches the name and its words, and says which name matched', () => {
    expect(buildNickCandidates(buf, 'me', 'bra', null, nameOf)).toEqual([
      { nick: 'amiantos', recent: false, displayName: 'Brad Root' },
      { nick: 'brad_', recent: false },
    ]);
    expect(buildNickCandidates(buf, 'me', 'root', null, nameOf)).toEqual([
      { nick: 'amiantos', recent: false, displayName: 'Brad Root' },
    ]);
    expect(buildNickCandidates(buf, 'me', 'ami', null, nameOf)).toEqual([
      { nick: 'amiantos', recent: false, displayName: 'Brad Root' },
    ]);
  });

  it('is the old matcher without a name source', () => {
    expect(buildNickCandidates(buf, 'me', 'bra')).toEqual([{ nick: 'brad_', recent: false }]);
  });
});
