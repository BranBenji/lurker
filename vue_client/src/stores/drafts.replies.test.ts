// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// A pending reply is part of the draft: it flushes with the text, comes back
// with it from the snapshot and from another device's update, and the pagehide
// beacon carries it. A local change holds off a remote one, as typing does.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { socketSend } from '../composables/useSocket.js';
import { useDraftStore } from './drafts.js';
import { useRepliesStore } from './replies.js';
import type { DraftReply } from '../../../shared/replies.js';

const KEY = '1::#chan';
const REPLY = { messageId: 42, nick: 'alice', type: 'message', text: 'what time is it?' };
const fromServer = (over: Partial<DraftReply> = {}): DraftReply => ({
  messageId: 42,
  addressed: true,
  parent: {
    id: 42,
    nick: 'alice',
    type: 'message',
    text: 'what time is it?',
    userhost: null,
    self: false,
  },
  ...over,
});
const frames = () => vi.mocked(socketSend).mock.calls.map((c) => c[0] as Record<string, unknown>);

describe('a draft’s reply', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    useDraftStore().resetTimers();
  });

  it('flushes with the draft, even with no text, and a cancel clears it', () => {
    const drafts = useDraftStore();
    useRepliesStore().start(KEY, REPLY);
    expect(drafts.hasDraft(1, '#chan')).toBe(true);
    drafts.flushBuffer(1, '#chan');
    expect(frames().at(-1)).toEqual({
      type: 'draft-set',
      networkId: 1,
      target: '#chan',
      body: '',
      reply: { messageId: 42, addressed: false },
    });
    drafts.setLocal(1, '#chan', 'alice: noon');
    useRepliesStore().markAddressed(KEY, 'alice');
    drafts.flushBuffer(1, '#chan');
    expect(frames().at(-1)).toMatchObject({
      body: 'alice: noon',
      reply: { messageId: 42, addressed: true },
    });
    useRepliesStore().cancel(KEY);
    drafts.setLocal(1, '#chan', '');
    drafts.flushBuffer(1, '#chan');
    expect(frames().at(-1)).toEqual({ type: 'draft-clear', networkId: 1, target: '#chan' });
  });

  it('comes back from the snapshot and another device’s update', () => {
    const drafts = useDraftStore();
    drafts.seed([{ networkId: 1, target: '#chan', body: '', reply: fromServer() }]);
    expect(useRepliesStore().forKey(KEY)).toEqual({ ...REPLY, self: false, addressed: true });
    expect(drafts.hasDraft(1, '#chan')).toBe(true);

    drafts.applyRemoteUpdate(1, '#chan', 'x', fromServer({ messageId: 7, addressed: false }));
    expect(useRepliesStore().forKey(KEY)?.messageId).toBe(7);
    // A frame with no reply key (an older server) leaves it; null clears it.
    drafts.applyRemoteUpdate(1, '#chan', 'y', undefined);
    expect(useRepliesStore().forKey(KEY)?.messageId).toBe(7);
    drafts.applyRemoteUpdate(1, '#chan', 'y', null);
    expect(useRepliesStore().forKey(KEY)).toBeNull();
  });

  // Reply clicked here, not flushed yet: an older copy from elsewhere mustn't
  // take it away, as it can't take away text still being typed.
  it('holds off a remote update and a snapshot until it has flushed', () => {
    const drafts = useDraftStore();
    useRepliesStore().start(KEY, REPLY);
    drafts.applyRemoteUpdate(1, '#chan', '', null);
    drafts.seed([]);
    expect(useRepliesStore().forKey(KEY)?.messageId).toBe(42);
  });

  it('rides the pagehide beacon', () => {
    const beacon = vi.fn<(url: string, data: Blob) => boolean>(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    useRepliesStore().start(KEY, REPLY);
    expect(useDraftStore().flushAllForBeacon()).toBe(true);
    const blob = beacon.mock.calls[0][1];
    return blob.text().then((json) => {
      expect(JSON.parse(json)).toEqual({
        drafts: [
          { networkId: 1, target: '#chan', body: '', reply: { messageId: 42, addressed: false } },
        ],
      });
    });
  });

  it('moves with a renamed buffer and goes with a closed one', () => {
    const drafts = useDraftStore();
    drafts.seed([{ networkId: 1, target: 'bob', body: '', reply: fromServer() }]);
    drafts.rekeyBuffer(1, 'bob', 'bobby');
    expect(useRepliesStore().forKey('1::bob')).toBeNull();
    expect(useRepliesStore().forKey('1::bobby')?.messageId).toBe(42);
    drafts.dropBuffer(1, 'bobby');
    expect(useRepliesStore().forKey('1::bobby')).toBeNull();
  });
});
