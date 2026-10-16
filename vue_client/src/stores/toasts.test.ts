// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useToastsStore } from './toasts.js';

describe('toasts store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores only the serializable label in state and runs the handler via runAction', () => {
    const toasts = useToastsStore();
    const onClick = vi.fn<() => void>();
    const id = toasts.push({
      title: 'Invitation to #secret',
      body: 'alice invited you',
      kind: 'notify',
      action: { label: 'Join', onClick },
      ttlMs: 0,
    });
    const t = toasts.items[0];
    // Pinia state holds only { label } — no function leaks into the store.
    expect(t.actions).toEqual([{ label: 'Join', tone: undefined }]);
    toasts.runAction(id);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('drops the action handler on dismiss so it cannot run afterward', () => {
    const toasts = useToastsStore();
    const onClick = vi.fn<() => void>();
    const id = toasts.push({ title: 'x', body: '', action: { label: 'Go', onClick }, ttlMs: 0 });
    toasts.dismiss(id);
    toasts.runAction(id); // no-op — handler was cleaned up
    expect(onClick).not.toHaveBeenCalled();
  });

  it('omits action when none is given (plain toast)', () => {
    const toasts = useToastsStore();
    toasts.push({ title: 'hi', body: '', ttlMs: 0 });
    expect(toasts.items[0].actions).toBeUndefined();
  });

  // #1085: an offer asks a question with three answers, and no ×.
  it('runs the action at the index pressed', () => {
    const toasts = useToastsStore();
    const accept = vi.fn<() => void>();
    const decline = vi.fn<() => void>();
    const id = toasts.push({
      title: 'DCC file from mira',
      body: 'talk.mp4',
      ttlMs: 0,
      dismissible: false,
      actions: [
        { label: 'Accept', onClick: accept, tone: 'good' },
        { label: 'Decline', onClick: decline, tone: 'bad' },
      ],
    });
    expect(toasts.items[0]).toMatchObject({
      dismissible: false,
      actions: [
        { label: 'Accept', tone: 'good' },
        { label: 'Decline', tone: 'bad' },
      ],
    });
    toasts.runAction(id, 1);
    expect(decline).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });

  it('auto-dismisses after the ttl', () => {
    const toasts = useToastsStore();
    toasts.push({ title: 'hi', body: '', ttlMs: 5000 });
    expect(toasts.items.length).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(toasts.items.length).toBe(0);
  });
});
