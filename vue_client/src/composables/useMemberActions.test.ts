// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(() => true),
}));

import { useMemberActions } from './useMemberActions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useConfigStore } from '../stores/config.js';
import { useDccStore } from '../stores/dcc.js';
import { parseModeSpec } from '../../../shared/channelModes.js';

function labelsFor(selfModes: string[]): string[] {
  return useMemberActions()
    .buildItems(
      { nick: 'target', modes: [] },
      { networkId: 1, isSelf: () => false, onIgnore: () => {}, channel: '#chan', selfModes },
    )
    .map((i) => i.label ?? '');
}

function prefix(spec: string): void {
  // `(Yohv)!@%+` → the pairs irc-framework hands parseModeSpec.
  const [, modes, symbols] = /\((.*)\)(.*)/.exec(spec)!;
  const PREFIX = [...modes].map((mode, i) => ({ mode, symbol: symbols[i] }));
  useNetworksStore().states[1] = {
    networkId: 1,
    channels: [],
    modeSpec: parseModeSpec({ PREFIX }),
  };
}

// Channel-operator actions are gated on the user's RANK in the network's PREFIX
// order (#727), not on a hardcoded letter list.
describe('useMemberActions channel-operator gating', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('offers moderation to a halfop but op management only from op up', () => {
    prefix('(qaohv)~&@%+');
    expect(labelsFor(['h'])).toContain('Kick…');
    expect(labelsFor(['h'])).not.toContain('Give Op');
    expect(labelsFor(['a'])).toContain('Give Op');
    expect(labelsFor(['v'])).not.toContain('Kick…');
  });

  it('lets a rank above op through, whatever its letter', () => {
    prefix('(Yohv)!@%+');
    expect(labelsFor(['Y'])).toContain('Give Op');
  });

  it('offers only the modes the network has', () => {
    // No voice on this network: nothing may send +v.
    prefix('(Yoh)!@%');
    expect(labelsFor(['Y'])).toContain('Give Op');
    expect(labelsFor(['Y'])).not.toContain('Give Voice');
  });

  it('falls back to the conventional ladder before the spec arrives', () => {
    expect(labelsFor(['q'])).toContain('Give Op');
    expect(labelsFor(['v'])).not.toContain('Kick…');
  });
});

// #1015: Reply addresses the speaker, which in a DM is only noise — the line
// goes to them anyway. A caller with no buffer (channel null) keeps it.
describe('useMemberActions Reply', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const labelsIn = (channel: string | null) =>
    useMemberActions()
      .buildItems('alice', { networkId: 1, isSelf: () => false, onIgnore: () => {}, channel })
      .map((i) => i.label ?? '');

  it('is offered in a channel, not in a DM or a DCC chat', () => {
    expect(labelsIn('#chan')).toContain('Reply to alice');
    expect(labelsIn(null)).toContain('Reply to alice');
    expect(labelsIn('alice')).not.toContain('Reply to alice');
    expect(labelsIn('=alice')).not.toContain('Reply to alice');
  });
});

// The DCC entries on a person (#1085, #1157): chat and send, plain and secure,
// each pair gated on its grant. KVIrc's menu minus its reverse entries.
describe('useMemberActions DCC entries', () => {
  beforeEach(() => setActivePinia(createPinia()));

  function grant(chat: boolean, send: boolean): void {
    useConfigStore().features.dcc = true;
    useDccStore().account = { chat, receive: true, send };
  }
  const dccLabels = (isSelf = false) =>
    useMemberActions()
      .buildItems(
        { nick: 'alice', modes: [] },
        { networkId: 1, isSelf: () => isSelf, onIgnore: () => {}, channel: '#chan', selfModes: [] },
      )
      .map((i) => i.label ?? '')
      .filter((l) => l.includes('(DCC)'));

  it('offers chat and send, plain and secure, in that order', () => {
    grant(true, true);
    expect(dccLabels()).toEqual([
      'Chat (DCC)',
      'Secure Chat (DCC)',
      'Send File (DCC)…',
      'Secure Send File (DCC)…',
    ]);
  });

  it('gates each pair on its own grant', () => {
    grant(true, false);
    expect(dccLabels()).toEqual(['Chat (DCC)', 'Secure Chat (DCC)']);
    grant(false, true);
    expect(dccLabels()).toEqual(['Send File (DCC)…', 'Secure Send File (DCC)…']);
    grant(false, false);
    expect(dccLabels()).toEqual([]);
  });

  it('offers none of it on yourself', () => {
    grant(true, true);
    expect(dccLabels(true)).toEqual([]);
  });
});

// #1182: Send DM opens the DM on the server, so an empty one can be pinned or
// made a friend.
describe('useMemberActions Send DM', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('asks the server to open the DM', async () => {
    const { socketSend } = await import('./useSocket.js');
    vi.mocked(socketSend).mockClear();
    useMemberActions()
      .buildItems('alice', { networkId: 1, isSelf: () => false, onIgnore: () => {}, channel: '#c' })
      .find((i) => i.label === 'Send DM')!.onClick!();
    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open-buffer', networkId: 1, target: 'alice' }),
    );
  });
});
