// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The DCC entries shared by every menu on a person (#1085, #1157): what each
// one asks the server for, and where the user lands.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));
vi.mock('../stores/config.js', () => ({
  useConfigStore: () => ({ fetch: async () => 'standalone', features: { dcc: true } }),
}));

import { dccActionItems } from './dccActionItems.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useDccStore } from '../stores/dcc.js';
import { useNetworksStore } from '../stores/networks.js';
import { useToastsStore } from '../stores/toasts.js';

const item = (label: string) => dccActionItems(1, 'alice').find((i) => i.label === label)!;

describe('dccActionItems', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.api.mockReset();
    useDccStore().account = { chat: true, receive: true, send: true };
  });

  it('asks for a chat as offered, plain or secure, and goes to its buffer', async () => {
    h.api.mockResolvedValue({});
    const activate = vi.spyOn(useBuffersStore(), 'activate').mockImplementation(() => {});
    await item('Chat (DCC)').onClick?.();
    expect(h.api).toHaveBeenLastCalledWith('/api/dcc/chat', {
      method: 'POST',
      body: { networkId: 1, nick: 'alice', passive: false, secure: false },
    });
    await item('Secure Chat (DCC)').onClick?.();
    expect(h.api).toHaveBeenLastCalledWith('/api/dcc/chat', {
      method: 'POST',
      body: { networkId: 1, nick: 'alice', passive: false, secure: true },
    });
    expect(activate).toHaveBeenCalledWith(1, '=alice');
  });

  // The server's refusals arrive as notices in the buffer. A failed request
  // never reaches the buffer, so it gets a toast rather than nothing.
  it('says so when the request itself fails', async () => {
    h.api.mockRejectedValue(new Error('DCC chat is not enabled for this account'));
    await item('Chat (DCC)').onClick?.();
    expect(useToastsStore().items.at(-1)).toMatchObject({
      title: 'DCC chat with alice',
      body: 'DCC chat is not enabled for this account',
    });
  });

  // A section of its own, like the Notifications ladder: a divider, a heading,
  // then the pairs in order. Nothing at all without a grant, so a caller can
  // spread it in unconditionally.
  it('is a headed section, or nothing', () => {
    expect(dccActionItems(1, 'alice').map((i) => i.heading ?? i.label ?? '|')).toEqual([
      '|',
      'DCC',
      'Chat (DCC)',
      'Secure Chat (DCC)',
      'Send File (DCC)…',
      'Secure Send File (DCC)…',
    ]);
    useDccStore().account = { chat: false, receive: true, send: false };
    expect(dccActionItems(1, 'alice')).toEqual([]);
  });

  it('picks a file for a send, plain or secure', () => {
    item('Send File (DCC)…').onClick?.();
    expect(useDccStore().pick).toMatchObject({ networkId: 1, nick: 'alice', secure: false });
    item('Secure Send File (DCC)…').onClick?.();
    expect(useDccStore().pick).toMatchObject({ networkId: 1, nick: 'alice', secure: true });
  });

  it("runs the caller's step, so a modal can close itself — after a chat request succeeds", async () => {
    const before = vi.fn<() => void>();
    vi.spyOn(useBuffersStore(), 'activate').mockImplementation(() => {});
    h.api.mockRejectedValue(new Error('network not connected'));
    await dccActionItems(1, 'alice', { before })
      .find((i) => i.label === 'Chat (DCC)')!
      .onClick?.();
    expect(before).not.toHaveBeenCalled(); // the modal stays for the toast
    h.api.mockResolvedValue({});
    await dccActionItems(1, 'alice', { before })
      .find((i) => i.label === 'Chat (DCC)')!
      .onClick?.();
    expect(before).toHaveBeenCalledOnce();

    // A send is a pick in the DCC window, so the step runs at once.
    dccActionItems(1, 'alice', { before })
      .find((i) => i.label === 'Send File (DCC)…')!
      .onClick?.();
    expect(before).toHaveBeenCalledTimes(2);
    expect(useDccStore().pick).not.toBeNull();
  });

  // The server would only say "Already in a DCC chat"; the send pair stays.
  it('drops the chat pair while a chat with that peer is live', () => {
    useNetworksStore().applyDccChatState(1, 'Alice', true);
    expect(
      dccActionItems(1, 'alice')
        .map((i) => i.label)
        .filter(Boolean),
    ).toEqual(['Send File (DCC)…', 'Secure Send File (DCC)…']);
  });
});
