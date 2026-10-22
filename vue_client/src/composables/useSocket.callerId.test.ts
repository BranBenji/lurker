// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Someone our caller ID (+g) turned away surfaces as a toast whose Accept
// sends ACCEPT for them (#206). Driven through the socket's message listener.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useLinkPreview.js', () => ({
  primePreviews: vi.fn<(texts: unknown[], toggles: unknown) => void>(),
  previewRevision: { value: 0 },
}));

const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor() {
    sockets.push(this);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  close(): void {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  deliver(frame: Record<string, unknown>): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
  }
}

import { useSocket, resetPreviewToggleWiring, resetSocket } from './useSocket.js';
import { useToastsStore } from '../stores/toasts.js';

const RouteView = defineComponent({
  setup() {
    useSocket();
    return () => null;
  },
});

describe('caller ID toast', () => {
  beforeEach(() => {
    resetSocket();
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
    setActivePinia(createPinia());
    resetPreviewToggleWiring();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetPreviewToggleWiring();
  });

  it('offers to accept the caller, and Accept sends ACCEPT', async () => {
    mount(RouteView);
    await nextTick();
    const ws = sockets.at(-1)!;
    ws.deliver({
      kind: 'irc',
      type: 'callerid-blocked',
      networkId: 1,
      target: ':server:1',
      from: 'bob',
      userhost: 'bob@example.test',
    });

    const toast = useToastsStore().items.find((t) => t.title === 'bob tried to message you');
    expect(toast?.actions).toEqual([{ label: 'Accept', tone: 'good' }]);
    useToastsStore().runAction(toast!.id, 0);
    expect(ws.sent).toContainEqual({ type: 'raw', networkId: 1, line: 'ACCEPT bob' });
  });
});
