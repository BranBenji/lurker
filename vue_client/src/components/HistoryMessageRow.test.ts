// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// A reply out of its buffer (#998) — a search hit, an activity item, a
// bookmark: it quotes what it answers, as the timeline does, and the quote is
// part of the row rather than a control of its own.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import HistoryMessageRow, { type HistoryMessage } from './HistoryMessageRow.vue';
import { useIgnoresStore } from '../stores/ignores.js';
import type { ReplyParent } from '../../../shared/replies.js';

const parent = (over: Partial<ReplyParent> = {}): ReplyParent => ({
  id: 1,
  nick: 'alice',
  type: 'message',
  text: 'which \x02branch\x02?',
  userhost: 'alice!~a@host',
  self: false,
  ...over,
});

const reply = (over: Partial<HistoryMessage> = {}): HistoryMessage => ({
  id: 2,
  networkId: 1,
  target: '#chan',
  type: 'message',
  nick: 'bob',
  text: 'alice: the release one',
  time: '2026-09-28T12:00:00.000Z',
  replyTo: { msgid: 'm1', parent: parent() },
  ...over,
});

const mountRow = (message: HistoryMessage) => mount(HistoryMessageRow, { props: { message } });

describe('HistoryMessageRow — replies', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('quotes the answered line, and drops the address it repeats', () => {
    const w = mountRow(reply());
    expect(w.find('.reply-quote .reply-text').text()).toBe('<alice> which branch?');
    expect(w.find('.text').text()).toBe('the release one');
  });

  it('says the answered line is unavailable, and keeps the address', () => {
    const w = mountRow(reply({ replyTo: { msgid: 'm1', parent: null } }));
    expect(w.find('.reply-text').text()).toBe('original message unavailable');
    expect(w.find('.text').text()).toBe('alice: the release one');
  });

  it('won’t quote someone ignored since', () => {
    useIgnoresStore().global = [
      {
        id: 1,
        createdAt: '',
        mask: 'alice!*@*',
        channels: null,
        pattern: null,
        patternKind: 'substr',
        levels: ['ALL'],
        isExcept: false,
        expiresAt: null,
      },
    ];
    const w = mountRow(reply());
    expect(w.find('.reply-text').text()).toBe('original message unavailable');
    expect(w.text()).not.toContain('branch');
    expect(w.find('.text').text()).toBe('alice: the release one');
  });

  it('keeps a /me’s text whole, as the timeline does', () => {
    const w = mountRow(reply({ type: 'action', text: 'alice: waves' }));
    expect(w.find('.reply-quote').exists()).toBe(true);
    expect(w.find('.text').text()).toBe('alice: waves');
  });

  it('shows no quote on a line that isn’t a reply', () => {
    const w = mountRow(reply({ replyTo: undefined }));
    expect(w.find('.reply-quote').exists()).toBe(false);
    expect(w.find('.text').text()).toBe('alice: the release one');
  });

  // The row's click jumps to the reply, where the quote is live again.
  it('leaves clicks on the quote to the row', async () => {
    const message = reply();
    const w = mountRow(message);
    const quote = w.find('.reply-quote');
    expect(quote.attributes('role')).toBeUndefined();
    expect(quote.attributes('tabindex')).toBeUndefined();
    await quote.trigger('click');
    expect(w.emitted('jump')).toEqual([[message]]);
    expect(w.findComponent({ name: 'ReplyQuote' }).emitted('jump')).toBeUndefined();
  });
});
