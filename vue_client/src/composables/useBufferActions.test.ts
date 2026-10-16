// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(() => true),
}));

import { useBufferActions } from './useBufferActions.js';
import { useChannelModal } from './useChannelModal.js';
import { useContextMenu } from './useContextMenu.js';
import { socketSend } from './useSocket.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useConfigStore } from '../stores/config.js';
import { useDccStore } from '../stores/dcc.js';

// Seeded the way production seeds it: the buffer exists, then a channel-joined /
// channel-parted frame (or the snapshot's live `joined`) sets the flag.
function channel(target: string, joined: boolean): void {
  const buffers = useBuffersStore();
  buffers.ensure(1, target);
  buffers.setJoined(1, target, joined);
}

function networkState(state: string): void {
  useNetworksStore().states[1] = { networkId: 1, channels: [], state };
}

describe('useBufferActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // The context menu is a module-level singleton — reset between cases.
    useContextMenu().close();
    vi.mocked(socketSend).mockClear();
  });

  describe('Join Channel', () => {
    // Every channel sigil, not just '#'.
    it.each(['#lurker', '&local', '+modeless', '!12345safe'])(
      'leads the menu of a parted %s and sends a JOIN for it',
      (target) => {
        networkState('connected');
        channel(target, false);
        const items = useBufferActions().buildItems({ networkId: 1, target });
        expect(items[0]).toMatchObject({ label: 'Join Channel', disabled: false });
        expect(items[1]).toEqual({ divider: true });
        items[0].onClick?.();
        expect(socketSend).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'join', networkId: 1, channel: target }),
        );
      },
    );

    it('is not offered on a joined channel', () => {
      networkState('connected');
      channel('#lurker', true);
      const items = useBufferActions().buildItems({ networkId: 1, target: '#lurker' });
      expect(items.map((i) => i.label)).not.toContain('Join Channel');
    });

    it('resolves the buffer case-insensitively', () => {
      networkState('connected');
      channel('#Lurker', false);
      const items = useBufferActions().buildItems({ networkId: 1, target: '#lurker' });
      expect(items[0]?.label).toBe('Join Channel');
    });

    it('is disabled while the network is not connected', () => {
      // A dropped network parts every channel, so the rows all carry the item
      // through a reconnect — there is no socket to send the JOIN on yet.
      networkState('reconnecting');
      channel('#lurker', false);
      const items = useBufferActions().buildItems({ networkId: 1, target: '#lurker' });
      expect(items[0]).toMatchObject({ label: 'Join Channel', disabled: true });
    });
  });

  describe('Channel Settings…', () => {
    afterEach(() => useChannelModal().close());

    it("opens the modal for the menu's channel, not whichever is on screen", () => {
      networkState('connected');
      channel('#elsewhere', true);
      const item = useBufferActions()
        .buildItems({ networkId: 1, target: '#elsewhere' })
        .find((i) => i.label === 'Channel Settings…');
      item!.onClick?.();
      expect(useChannelModal().current.value).toEqual({ networkId: 1, target: '#elsewhere' });
    });

    it('is not offered for a DM', () => {
      networkState('connected');
      const items = useBufferActions().buildItems({ networkId: 1, target: 'alice' });
      expect(items.map((i) => i.label)).not.toContain('Channel Settings…');
    });
  });

  describe('Send File (DCC)…', () => {
    function grant(send: boolean): void {
      useConfigStore().features.dcc = true;
      useDccStore().account = { chat: false, receive: true, send };
    }
    const sendItem = (target: string) =>
      useBufferActions()
        .buildItems({ networkId: 1, target })
        .find((i) => i.label === 'Send File (DCC)…');

    it("opens the DCC window picking a file for a DM's peer, or a DCC chat's", () => {
      grant(true);
      sendItem('alice')!.onClick?.();
      expect(useDccStore().pick).toMatchObject({ networkId: 1, nick: 'alice' });
      sendItem('=bob')!.onClick?.();
      expect(useDccStore().pick).toMatchObject({ networkId: 1, nick: 'bob' });
    });

    it('is not offered without the send grant, or for a channel', () => {
      grant(false);
      expect(sendItem('alice')).toBeUndefined();
      grant(true);
      expect(sendItem('#lurker')).toBeUndefined();
    });
  });
});
