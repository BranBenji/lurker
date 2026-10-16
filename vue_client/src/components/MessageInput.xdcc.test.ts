// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// `/xdcc` and `/dcc retry` through the real composer (#1085): what each one
// asks the DCC store for, and the receipt it leaves in the buffer.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useDccStore, type DccTransfer } from '../stores/dcc.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let mounted: VueWrapper[] = [];

function seed() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [
    { id: 1, name: 'rizon' },
    { id: 2, name: 'libera' },
  ] as never;
  networks.states = { 1: { nick: 'me' } } as never;
  buffers.buffers['1::#chan'] = {
    networkId: 1,
    target: '#chan',
    members: [],
    messages: [],
  } as never;
  networks.activeKey = '1::#chan';
  useRecentBuffersStore().keys = ['1::#chan'];
}

function row(over: Partial<DccTransfer>): DccTransfer {
  return {
    id: 1,
    network_id: 1,
    peer_nick: 'Bot',
    direction: 'recv',
    filename: 'XDCC #1',
    advertised_size: 100,
    received_bytes: 0,
    state: 'queued',
    crc_status: null,
    error: null,
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
    completed_at: null,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function run(command: string) {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  const el = wrapper.find('textarea').element as HTMLTextAreaElement;
  el.value = command;
  el.setSelectionRange(command.length, command.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  await flush();
}

const output = () =>
  (useBuffersStore().buffers['1::#chan'] as unknown as { messages: { text: string }[] }).messages
    .map((m) => m.text)
    .join('\n');

describe('/xdcc', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seed();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
    vi.restoreAllMocks();
  });

  it('queues a range and names what was queued', async () => {
    const dcc = useDccStore();
    const queue = vi
      .spyOn(dcc, 'queueXdcc')
      .mockResolvedValue([
        row({ id: 4, pack: 29 }),
        row({ id: 5, pack: 30 }),
        row({ id: 6, pack: 31 }),
      ]);
    await run('/xdcc addl Bot 29 31');
    expect(queue).toHaveBeenCalledWith(1, 'Bot', [29, 30, 31]);
    expect(output()).toContain('/xdcc: queued #29–#31 from Bot');
  });

  it('says so when every pack asked for is already queued', async () => {
    vi.spyOn(useDccStore(), 'queueXdcc').mockResolvedValue([]);
    await run('/xdcc add Bot 29');
    expect(output()).toContain('/xdcc: #29 already in the queue for Bot');
  });

  it('removes packs, or a whole bot, and counts them', async () => {
    const dcc = useDccStore();
    const unqueue = vi.spyOn(dcc, 'unqueueXdcc').mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await run('/xdcc rmp Bot 31');
    expect(unqueue).toHaveBeenCalledWith(1, 'Bot', [31]);
    expect(output()).toContain('/xdcc: took 1 pack out of the queue for Bot');
    await run('/xdcc rmbot Bot');
    expect(unqueue).toHaveBeenLastCalledWith(1, 'Bot', null);
    expect(output()).toContain('/xdcc: nothing in the queue for Bot to take out');
  });

  it("reports the server's refusal", async () => {
    vi.spyOn(useDccStore(), 'queueXdcc').mockRejectedValue(new Error('network not connected'));
    await run('/xdcc add Bot 29');
    expect(output()).toContain('/xdcc: network not connected');
  });

  it('prints a usage error without asking the server', async () => {
    const queue = vi.spyOn(useDccStore(), 'queueXdcc');
    await run('/xdcc addl Bot 30');
    expect(output()).toMatch(/^\/xdcc: /m);
    expect(queue).not.toHaveBeenCalled();
  });

  it("lists this network's queues, a bot at a time, the pack out first", async () => {
    const dcc = useDccStore();
    vi.spyOn(dcc, 'load').mockResolvedValue([
      row({ id: 6, pack: 32, queue_seq: 3 }),
      row({ id: 5, pack: 31, queue_seq: 2 }),
      row({
        id: 4,
        pack: 30,
        queue_seq: 1,
        state: 'receiving',
        filename: 'ep30.mkv',
        received_bytes: 41,
      }),
      row({
        id: 7,
        pack: 9,
        peer_nick: 'Other',
        filename: 'XDCC #9',
        state: 'requested',
        bot_acked_at: '2026-10-16T00:00:00.000Z',
      }),
      // Another network's, finished ones, and a plain DCC receive are left out.
      row({ id: 8, pack: 1, network_id: 2 }),
      row({ id: 9, pack: 2, state: 'completed' }),
      row({ id: 10, pack: null, state: 'receiving' }),
    ]);
    await run('/xdcc queue');
    const out = output();
    expect(dcc.panelOpen).toBe(true);
    expect(out).toContain('Bot (rizon)');
    expect(out).toMatch(/#30\s+receiving\s+41%\s+ep30\.mkv/);
    expect(out.indexOf('#30')).toBeLessThan(out.indexOf('#31'));
    expect(out.indexOf('#31')).toBeLessThan(out.indexOf('#32'));
    expect(out).toContain('Other (rizon)');
    expect(out).toMatch(/#9\s+in the bot's queue/);
    expect(out).not.toMatch(/#1\b|#2\b/);
  });

  it('lists one bot, or says nothing is queued', async () => {
    vi.spyOn(useDccStore(), 'load').mockResolvedValue([row({ id: 5, pack: 31 })]);
    await run('/xdcc queue Other');
    expect(output()).toContain('no packs queued from Other.');
    await run('/xdcc queue bot');
    expect(output()).toContain('Bot (rizon)');
  });

  it('says why the list could not load', async () => {
    vi.spyOn(useDccStore(), 'load').mockRejectedValue(new Error('offline'));
    await run('/xdcc queue');
    expect(output()).toContain('/xdcc: offline');
  });
});

describe('/dcc retry', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seed();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
    vi.restoreAllMocks();
  });

  it('puts the pack at the front of its queue and says so', async () => {
    const retry = vi.spyOn(useDccStore(), 'retry').mockResolvedValue(row({ id: 12, pack: 29 }));
    await run('/dcc retry 6');
    expect(retry).toHaveBeenCalledWith(6);
    expect(output()).toContain('/dcc retry: #29 from Bot is next in the queue');
  });

  it("reports the server's refusal", async () => {
    vi.spyOn(useDccStore(), 'retry').mockRejectedValue(new Error('not retryable'));
    await run('/dcc retry 6');
    expect(output()).toContain('/dcc retry: #6 — not retryable');
  });
});
