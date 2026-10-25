// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import type { Router } from 'vue-router';
import { navigateThread, onThreadNav, requestThreadNav } from './useThreadNav.js';

describe('useThreadNav', () => {
  it('hands a request to every listener, and a listener can leave', () => {
    const a = vi.fn<() => void>();
    const b = vi.fn<() => void>(() => {
      throw new Error('a bad listener');
    });
    const offA = onThreadNav(a);
    const offB = onThreadNav(b);
    requestThreadNav({ kind: 'list', bufferId: 7 });
    expect(a).toHaveBeenCalledWith({ kind: 'list', bufferId: 7 });
    offA();
    offB();
    requestThreadNav({ kind: 'close', bufferId: 7 });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('navigates to the thread, list and buffer routes', () => {
    const push = vi.fn<(to: unknown) => Promise<void>>(() => Promise.resolve());
    const router = { push } as unknown as Router;
    navigateThread(router, { kind: 'thread', bufferId: 7, rootMsgid: 'abc', focusId: 42 });
    navigateThread(router, { kind: 'thread', bufferId: 7, rootMsgid: 'abc' });
    navigateThread(router, { kind: 'list', bufferId: 7 });
    navigateThread(router, { kind: 'close', bufferId: 7 });
    expect(push.mock.calls.map((c) => c[0])).toEqual([
      { name: 'buffer-thread', params: { id: '7', root: 'abc' }, query: { focus: '42' } },
      { name: 'buffer-thread', params: { id: '7', root: 'abc' }, query: {} },
      { name: 'buffer-threads', params: { id: '7' } },
      '/buffer/7',
    ]);
  });
});
