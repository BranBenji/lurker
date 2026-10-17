// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(() => true),
}));

import { useNotifyLadder } from './useNotifyLadder.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useIgnoresStore } from '../stores/ignores.js';

describe('useNotifyLadder channel rungs', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(useIgnoresStore(), 'addRule').mockImplementation(() => undefined as never);
    vi.spyOn(useIgnoresStore(), 'removeRule').mockImplementation(() => undefined as never);
  });

  // A rung is a target: it reconciles against the state at the tap, not as it
  // was when the menu opened (#1136).
  it('clears notify-always set elsewhere while the menu was open', () => {
    const notify = useChannelNotifyStore();
    const set = vi.spyOn(notify, 'setNotifyAlways');
    const items = useNotifyLadder().channelItems(1, '#chan');
    // Another device turns All messages on while this menu sits open.
    notify.applyChange(1, '#chan', { notifyAlways: true });
    items.find((i) => i.label === 'Highlights only')?.onClick?.();
    expect(set).toHaveBeenCalledWith(1, '#chan', false);
  });

  it('leaves notify-always alone when it already matches at the tap', () => {
    const notify = useChannelNotifyStore();
    const set = vi.spyOn(notify, 'setNotifyAlways');
    notify.applyChange(1, '#chan', { notifyAlways: true });
    const items = useNotifyLadder().channelItems(1, '#chan');
    // Turned off elsewhere; Highlights only now has nothing to change there.
    notify.applyChange(1, '#chan', { notifyAlways: false });
    items.find((i) => i.label === 'Highlights only')?.onClick?.();
    expect(set).not.toHaveBeenCalled();
  });
});
