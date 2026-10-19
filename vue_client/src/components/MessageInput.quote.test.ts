// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The composer's side of Quote (#1119), through the real component: the quoted
// line lands above the draft with the caret under it, and the two-line send it
// makes goes out without the split confirmation — which a line torn by word
// wrap still gets.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useToastsStore } from '../stores/toasts.js';
import { quoteInComposer } from '../composables/useComposerOverlay.js';
import { useComposing } from '../composables/useComposing.js';
import { socketSendWithAck } from '../composables/useSocket.js';
import MessageInput from './MessageInput.vue';

type AckResult = { ok: boolean; error?: string };

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  socketSendWithAck: vi.fn<() => Promise<AckResult> | null>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const KEY = '1::#chan';
const QUOTE = '> <alice> what time is it?';

let mounted: VueWrapper[] = [];

function seed() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected' } } as never;
  buffers.buffers[KEY] = { networkId: 1, target: '#chan', members: [], messages: [] } as never;
  networks.activeKey = KEY;
  useRecentBuffersStore().keys = [KEY];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function composer(): Promise<HTMLTextAreaElement> {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  return wrapper.find('textarea').element as HTMLTextAreaElement;
}

async function type(el: HTMLTextAreaElement, value: string) {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

async function press(el: HTMLTextAreaElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  await flush();
  await flush();
}

const sent = () =>
  vi.mocked(socketSendWithAck).mock.calls.map((c) => c[0] as Record<string, unknown>);

describe('quoting a line', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSendWithAck).mockClear();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('puts the quote above the draft, on its own line, with the caret at the end', async () => {
    seed();
    const el = await composer();
    await type(el, 'noon');
    quoteInComposer(QUOTE);
    await flush();
    expect(el.value).toBe(`${QUOTE}\nnoon`);
    expect(el.selectionStart).toBe(el.value.length);
    expect(document.activeElement).toBe(el);
  });

  it('opens an empty draft as the quote and a fresh line under it', async () => {
    seed();
    const el = await composer();
    quoteInComposer(QUOTE);
    await flush();
    expect(el.value).toBe(`${QUOTE}\n`);
    // The SPLIT chip already says what the send will be.
    expect(useComposing().chunks).toBe(1);
  });

  it('stacks a second quote above the first', async () => {
    seed();
    const el = await composer();
    quoteInComposer(QUOTE);
    await flush();
    await type(el, `${QUOTE}\nboth of you`);
    quoteInComposer('> <bob> three');
    await flush();
    expect(el.value).toBe(`> <bob> three\n${QUOTE}\nboth of you`);
  });

  it('sends the quote and the answer as two typed lines without asking', async () => {
    seed();
    const el = await composer();
    await type(el, `${QUOTE}\nnoon`);
    expect(useComposing().chunks).toBe(2);
    expect(useComposing().typedLines).toBe(2);
    await press(el, 'Enter');
    expect(sent()).toEqual([
      expect.objectContaining({ type: 'send', target: '#chan', text: `${QUOTE}\nnoon` }),
    ]);
    expect(useToastsStore().items).toEqual([]);
    expect(el.value).toBe('');
  });

  it('still asks before sending one line torn in two by word wrap', async () => {
    seed();
    const el = await composer();
    await type(el, 'x'.repeat(600));
    expect(useComposing().chunks).toBe(2);
    expect(useComposing().typedLines).toBe(1);
    await press(el, 'Enter');
    expect(sent()).toEqual([]);
    expect(useToastsStore().items.map((t) => t.title)).toEqual([
      'Will split into 2 lines — Send again to confirm',
    ]);
    await press(el, 'Enter');
    expect(sent()).toHaveLength(1);
  });

  it('still offers the upload at three typed lines', async () => {
    seed();
    const el = await composer();
    await type(el, `${QUOTE}\n> <bob> three\nboth of you`);
    await press(el, 'Enter');
    expect(sent()).toEqual([]);
  });
});
