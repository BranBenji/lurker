// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The thread panel's composer (#1225): what a send names and addresses, what
// it refuses, and Tab completion from the channel's members.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ThreadComposer from './ThreadComposer.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useThreadsStore } from '../stores/threads.js';
import type { ThreadMessage } from '../stores/threads.js';
import { useToastsStore } from '../stores/toasts.js';
import { socketSendWithAck } from '../composables/useSocket.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<{ ok: boolean }>>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

function line(id: number, over: Record<string, unknown> = {}): ThreadMessage {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick: 'alice',
    text: `line ${id}`,
    msgid: `m${id}`,
    time: new Date(Date.UTC(2026, 9, 24, 12, id)).toISOString(),
    ...over,
  } as ThreadMessage;
}

function seed(target = '#chan', root: ThreadMessage | null = line(1)) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', canReply: true } } as never;
  const b = buffers.ensure(1, target, 9);
  b.members = [
    { nick: 'alice', modes: [], away: false },
    { nick: 'albert', modes: [], away: false },
  ];
  const threads = useThreadsStore();
  threads.open(9, 'm1');
  threads.applyThread({
    bufferId: 9,
    rootMsgid: 'm1',
    token: threads.view!.token,
    root: root ? { ...root, target } : null,
    replies: [line(2, { nick: 'bob', target, replyTo: { msgid: 'm1', root: 'm1', parent: null } })],
  });
  return threads;
}

async function type(text: string): Promise<HTMLTextAreaElement> {
  wrapper = mount(ThreadComposer, { attachTo: document.body });
  await wrapper.vm.$nextTick();
  const ta = wrapper.find('textarea');
  await ta.setValue(text);
  return ta.element as HTMLTextAreaElement;
}

const sends = () => vi.mocked(socketSendWithAck).mock.calls.map((c) => c[0]);

describe('ThreadComposer', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSendWithAck).mockClear();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('Enter sends a reply to the first line, addressed to its author', async () => {
    seed();
    const ta = await type('me too');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()).toEqual([
      { type: 'send', networkId: 1, target: '#chan', text: 'alice: me too', replyTo: 1 },
    ]);
    await wrapper!.vm.$nextTick();
    expect(ta.value).toBe('');
  });

  it('a picked line is answered instead, and the pick clears on send', async () => {
    const threads = seed();
    threads.setPending({ messageId: 2, nick: 'bob', type: 'message', text: 'x', self: false });
    await type('indeed');
    expect(wrapper!.find('.replying').text()).toContain('bob');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ text: 'bob: indeed', replyTo: 2 });
    expect(threads.pending).toBeNull();
  });

  it('no address on your own line or in a DM', async () => {
    seed('#chan', line(1, { nick: 'me', self: true }));
    await type('to clarify');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ text: 'to clarify', replyTo: 1 });
    wrapper!.unmount();
    setActivePinia(createPinia());
    vi.mocked(socketSendWithAck).mockClear();
    seed('alice');
    await type('in a dm');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ target: 'alice', text: 'in a dm', replyTo: 1 });
  });

  it('refuses a /command with a toast; // escapes one slash', async () => {
    seed();
    await type('/msg bob secret');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()).toEqual([]);
    expect(useToastsStore().items.at(-1)?.title).toMatch(/Commands/);
    await wrapper!.find('textarea').setValue('//literal');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ text: 'alice: /literal' });
  });

  it('Tab completes a nick from the members, cycling on repeat', async () => {
    seed();
    const ta = await type('al');
    ta.setSelectionRange(2, 2);
    await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
    expect(ta.value).toBe('alice: ');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
    expect(ta.value).toBe('albert: ');
    // Mid-line: a bare nick and a space.
    await wrapper!.find('textarea').setValue('hey al');
    ta.setSelectionRange(6, 6);
    await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
    expect(ta.value).toBe('hey alice ');
  });

  it('is disabled while the network cannot carry a reply tag', async () => {
    seed();
    useNetworksStore().states[1] = { nick: 'me', state: 'connected', canReply: false } as never;
    await type('x');
    expect((wrapper!.find('textarea').element as HTMLTextAreaElement).disabled).toBe(true);
  });
});
