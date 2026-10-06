// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The prompt's own-rank glyph follows the network's PREFIX (#1032).

import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSelfLabel } from './useSelfLabel.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

function labelFor(modes: string[], prefix: { mode: string; symbol: string }[] | null): string {
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = {
    1: { nick: 'me', state: 'connected', modeSpec: prefix ? { prefix } : null },
  } as never;
  const b = useBuffersStore().ensure(1, '#chan', 9);
  b.members = [{ nick: 'me', modes, away: false }];
  networks.activeKey = '1::#chan';
  return useSelfLabel().promptLabelNoModes.value;
}

describe('useSelfLabel — own rank', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("shows the network's symbol for your rank", () => {
    expect(labelFor(['Y'], [{ mode: 'Y', symbol: '!' }])).toBe('!me');
    expect(labelFor(['o'], [{ mode: 'o', symbol: '*' }])).toBe('*me');
  });

  it('uses the conventional table before ISUPPORT', () => {
    expect(labelFor(['o'], null)).toBe('@me');
  });
});
