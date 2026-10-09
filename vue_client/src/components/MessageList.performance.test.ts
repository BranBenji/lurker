// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import MessageList from './MessageList.vue';
import MessageBody from './MessageBody.vue';
import RenderSegments from './RenderSegments.vue';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useConfigStore } from '../stores/config.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import { primePreviews, resetLinkPreviewCache } from '../composables/useLinkPreview.js';
import { loadEmoji } from '../utils/emojiShortcodes.js';
import * as apiModule from '../api.js';
import * as tokens from '../utils/nickColor.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

function line(id: number, text = `alice: line ${id}`) {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick: 'bob',
    text,
    time: new Date(Date.UTC(2026, 9, 8, 12, 0, id)).toISOString(),
  };
}

let wrapper: VueWrapper;
function mountMessages(messages: ReturnType<typeof line>[]) {
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = useBuffersStore().ensure(1, '#chan', 9);
  b.messages = messages;
  b.members = [{ nick: 'alice', modes: [], away: false }];
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return b;
}

function segments(id: number) {
  return wrapper.find(`[data-msg-id="${id}"]`).findComponent(RenderSegments).props('segments');
}

describe('MessageList — incremental text parsing', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetLinkPreviewCache();
  });
  afterEach(() => {
    wrapper?.unmount();
    resetLinkPreviewCache();
    vi.restoreAllMocks();
  });

  // Mount the full ring to exercise eviction. Assert work counts, not timing;
  // concurrent CI workers can take several seconds just to construct the DOM.
  it('only parses new rows on successive appends, including ring eviction', async () => {
    const split = vi.spyOn(tokens, 'splitTextByTokens');
    mountMessages(Array.from({ length: 500 }, (_, i) => line(i + 1)));
    await nextTick();
    const original = segments(400);
    split.mockClear();
    for (let id = 501; id <= 503; id++) {
      useBuffersStore().pushMessage(line(id));
      await nextTick();
      expect(wrapper.find(`[data-msg-id="${id}"] .body`).text()).toBe(`alice: line ${id}`);
    }
    expect(split).toHaveBeenCalledTimes(3);
    expect(segments(400)).toBe(original);
    expect(wrapper.findAll('[data-msg-id]')).toHaveLength(500);
    expect(wrapper.find('[data-msg-id="1"]').exists()).toBe(false);
  }, 15_000);

  it('reuses relay and reply bodies while refreshing changed display rows', async () => {
    const relays = useRelayBotsStore();
    relays.applyUpdate(1, 'bridge', true, '');
    const b = mountMessages([
      { ...line(1, '[irc] <alice> hello'), nick: 'bridge' },
      {
        ...line(2, 'alice: answer'),
        replyTo: {
          msgid: 'parent',
          parent: {
            id: 99,
            nick: 'alice',
            type: 'message',
            text: 'question',
            userhost: null,
            self: false,
          },
        },
      },
    ] as Parameters<typeof mountMessages>[0]);
    await nextTick();
    expect(wrapper.find('[data-msg-id="1"] .body').text()).toBe('[irc]hello');
    expect(segments(2)).toEqual([{ text: 'answer' }]);
    const relaySegments = segments(1);
    const replySegments = segments(2);
    const split = vi.spyOn(tokens, 'splitTextByTokens');
    for (let id = 3; id <= 5; id++) {
      useBuffersStore().pushMessage(line(id, 'new body'));
      await nextTick();
    }
    expect(split).toHaveBeenCalledTimes(3);
    expect(segments(1)).toBe(relaySegments);
    expect(segments(2)).toBe(replySegments);

    b.messages[0].text = '[matrix] <alice> hello';
    await nextTick();
    expect(wrapper.find('[data-msg-id="1"] .body').text()).toBe('[matrix]hello');
    const oldTime = wrapper.find('[data-msg-id="1"] .time').text();
    b.messages[0].time = '2026-10-08T18:45:00.000Z';
    await nextTick();
    expect(wrapper.find('[data-msg-id="1"] .time').text()).not.toBe(oldTime);
    b.messages[0].text = '[matrix] <carol> edited';
    await nextTick();
    expect(wrapper.find('[data-msg-id="1"]').text()).toContain('carol');
    expect(wrapper.find('[data-msg-id="1"]').text()).toContain('matrix');
    expect(wrapper.find('[data-msg-id="1"] .body').text()).toBe('[matrix]edited');
    b.messages[1].replyTo = { msgid: 'parent', parent: null };
    await nextTick();
    expect(
      segments(2)
        .map((segment) => segment.text)
        .join(''),
    ).toBe('alice: answer');
    relays.applyUpdate(1, 'bridge', false, '');
    await nextTick();
    expect(wrapper.find('[data-msg-id="1"] .body').text()).toBe('[matrix] <carol> edited');
    relays.applyUpdate(1, 'bridge', true, '');
    await nextTick();
    expect(wrapper.find('[data-msg-id="1"] .body').text()).toBe('[matrix]edited');
  });

  it('reparses edited text and action authors, even without replacing the message', async () => {
    const b = mountMessages([line(1), { ...line(2, 'waves'), type: 'action' }]);
    await nextTick();
    const split = vi.spyOn(tokens, 'splitTextByTokens');
    b.messages[0].text = '\x02changed\x02';
    await nextTick();
    expect(segments(1)).toEqual([{ text: 'changed', bold: true }]);
    expect(split).toHaveBeenCalledTimes(1);
    b.messages[1].nick = 'alice';
    await nextTick();
    expect(segments(2)[0]).toMatchObject({ text: 'alice', self: false });
    expect(
      segments(2)
        .map((s) => s.text)
        .join(''),
    ).toBe('alice waves');
    expect(split).toHaveBeenCalledTimes(2);
    // A fresh backlog object with the same id must not reuse stale segments.
    b.messages = [line(1, 'replacement')];
    await nextTick();
    expect(segments(1)).toEqual([{ text: 'replacement' }]);
  });

  it('tracks member edits, own nick, and palette changes after cache hits', async () => {
    const settings = useSettingsStore();
    settings.values['look.nick.colors'] = ['#123456'];
    const b = mountMessages([line(1, 'alice me carol')]);
    // Cause a cache hit before each change, so dependencies must survive reuse.
    const repaint = async (id: number) => {
      b.messages.push(line(id, 'unrelated'));
      await nextTick();
    };
    expect(segments(1)[0]).toMatchObject({ text: 'alice', color: '#123456' });
    await repaint(2);
    settings.values['look.nick.colors'] = ['#abcdef'];
    await nextTick();
    expect(segments(1)[0]).toMatchObject({ text: 'alice', color: '#abcdef' });
    await repaint(3);
    b.members[0].nick = 'carol';
    await nextTick();
    expect(segments(1)[0]).toEqual({ text: 'alice ' });
    expect(segments(1).at(-1)).toMatchObject({ text: 'carol', color: '#abcdef' });
    await repaint(4);
    useNetworksStore().states[1].nick = 'carol';
    await nextTick();
    expect(segments(1)).toEqual([
      { text: 'alice me ' },
      { text: 'carol', color: null, self: true },
    ]);
  });

  it('reuses loaded rows on a buffer return without mixing network nick context', async () => {
    mountMessages([line(1, 'alice me')]);
    const buffers = useBuffersStore();
    const networks = useNetworksStore();
    const other = buffers.ensure(2, '#other', 10);
    networks.states[2] = { nick: 'alice', state: 'connected', peerPresence: {} } as never;
    other.messages = [{ ...line(1, 'alice me'), networkId: 2, target: '#other' }];
    other.hasMoreOlder = false;
    networks.activeKey = '2::#other';
    await nextTick();
    expect(segments(1)[0]).toMatchObject({ text: 'alice', self: true });
    networks.activeKey = '1::#chan';
    await nextTick();
    expect(segments(1)[0]).toMatchObject({ text: 'alice', self: false });
    expect(segments(1).at(-1)).toMatchObject({ text: 'me', self: true });
  });

  it('refreshes text and membership changed while a cached row was inactive', async () => {
    useSettingsStore().values['look.nick.colors'] = ['#123456'];
    const b = mountMessages([line(1, 'alice: before')]);
    const original = segments(1);
    b.messages.push(line(2));
    await nextTick();
    expect(segments(1)).toBe(original);

    const networks = useNetworksStore();
    const other = useBuffersStore().ensure(1, '#other', 10);
    other.messages = [{ ...line(3, 'other buffer'), target: '#other' }];
    other.hasMoreOlder = false;
    networks.activeKey = '1::#other';
    await nextTick();

    const split = vi.spyOn(tokens, 'splitTextByTokens');
    b.messages[0].text = 'alice carol: after';
    b.members[0].nick = 'carol';
    await nextTick();
    expect(split).not.toHaveBeenCalled();
    expect(wrapper.find('[data-msg-id="3"] .body').text()).toBe('other buffer');

    networks.activeKey = '1::#chan';
    await nextTick();
    expect(segments(1)).not.toBe(original);
    expect(segments(1)).toEqual([
      { text: 'alice ' },
      { text: 'carol', color: '#123456', self: false },
      { text: ': after' },
    ]);
    expect(wrapper.find('[data-msg-id="1"] .body .msg-nick').text()).toBe('carol');
  });

  it('restores exact cached text and formatting after hiding a preview URL', async () => {
    const url = 'https://images.example/cache-test.png';
    // Separate runs exercise both leading and trailing trims; the final dot
    // exercises punctuation removed with the hidden URL, not just the link.
    const text = `\x02  look\x02 at this  ${url}.`;
    const expected = [
      { text: '  look', bold: true },
      { text: ' at this  ' },
      { text: url, url },
      { text: '.' },
    ];
    useConfigStore().features.linkPreviews = true;
    const settings = useSettingsStore();
    settings.values['chat.inline_media.enabled'] = true;
    settings.values['chat.link_previews.enabled'] = true;
    settings.values['chat.inline_media.hide_urls'] = true;
    const request = vi.spyOn(apiModule, 'api').mockResolvedValue({
      previews: [
        {
          url,
          status: 'ok',
          kind: 'image',
          src: '/cache-test.png',
          thumbWidth: 320,
          thumbHeight: 180,
          expiresAt: '2099-01-01T00:00:00Z',
        },
      ],
    });
    mountMessages([line(1, text)]);
    const row = wrapper.find('[data-msg-id="1"]');
    const cached = row.findComponent(MessageBody).props('segments');
    expect(cached).toEqual(expected);
    expect(row.find('.msg-link').attributes('href')).toBe(url);
    const split = vi.spyOn(tokens, 'splitTextByTokens');

    primePreviews([text], { inlineMedia: true, linkPreviews: true });
    await vi.waitFor(() => expect(row.find('img.inline-image').exists()).toBe(true));
    expect(request).toHaveBeenCalledTimes(1);
    expect(row.find('.msg-link').exists()).toBe(false);
    expect(row.find('.body').element.textContent).toBe('look at this');
    useBuffersStore().pushMessage(line(2, 'unrelated append'));
    await nextTick();
    expect(row.findComponent(MessageBody).props('segments')).toBe(cached);
    expect(cached).toEqual(expected);
    expect(split).toHaveBeenCalledTimes(1);

    // First restore within MessageBody, then take MessageList's bare-renderer
    // branch. Neither path should need to reconstruct the original segments.
    settings.values['chat.inline_media.enabled'] = false;
    await nextTick();
    expect(row.find('img.inline-image').exists()).toBe(false);
    expect(segments(1)).toBe(cached);
    settings.values['chat.link_previews.enabled'] = false;
    await nextTick();
    expect(row.findComponent(MessageBody).exists()).toBe(false);
    expect(segments(1)).toBe(cached);
    expect(segments(1)).toEqual(expected);
    expect(row.find('.body').element.textContent).toBe(`  look at this  ${url}.`);
    expect(row.find('.body span[style*="font-weight: bold"]').element.textContent).toBe('  look');
    expect(row.find('.msg-link').attributes('href')).toBe(url);
    expect(split).toHaveBeenCalledTimes(1);
  });

  it('reparses cached shortcodes when the emoji table arrives', async () => {
    const b = mountMessages([line(1, ':tada:')]);
    expect(segments(1)).toEqual([{ text: ':tada:' }]);
    b.messages.push(line(2));
    await nextTick();
    await loadEmoji();
    await nextTick();
    expect(segments(1)).toEqual([{ text: '🎉' }]);
  });
});
