// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The reply line above a reply (#993), through the real MessageList: what it
// quotes, when it quotes nothing, the `nick: ` it makes redundant, the
// highlight a reply to you carries, and what the Reply action starts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { useRepliesStore } from '../stores/replies.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import type { ReplyParent } from '../../../shared/replies.js';
import * as jumpIntent from '../composables/useJumpIntent.js';
import * as composerOverlay from '../composables/useComposerOverlay.js';
import { useSettingsStore } from '../stores/settings.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const KEY = '1::#chan';
let wrapper: VueWrapper | null = null;

const parent = (over: Partial<ReplyParent> = {}): ReplyParent => ({
  id: 1,
  nick: 'alice',
  type: 'message',
  text: 'what \x02time\x02 is it?',
  userhost: 'alice!~a@host',
  self: false,
  ...over,
});

let nextId = 1;
function line(nick: string, text: string, extra: Record<string, unknown> = {}) {
  const id = nextId++;
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick,
    text,
    userhost: `${nick}!~u@host`,
    time: new Date(Date.UTC(2026, 8, 25, 12, id)).toISOString(),
    self: nick === 'me',
    ...extra,
  };
}

function mountWith(messages: Record<string, unknown>[]) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.messages = messages as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = KEY;
  wrapper = mount(MessageList, { attachTo: document.body });
  return wrapper;
}

const rowOf = (w: VueWrapper, id: number) => w.find(`[data-msg-id="${id}"]`);
type Row = ReturnType<typeof rowOf>;
// The message's own text: its body without the quote that opens it.
const ownText = (row: Row) => {
  const quote = row.find('.reply-quote');
  const body = row.find('.body').text();
  return (quote.exists() ? body.replace(quote.text(), '') : body).trim();
};

describe('MessageList — replies', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('quotes the answered line above the reply, and drops the address it repeats', () => {
    const p = line('alice', 'what \x02time\x02 is it?', { msgid: 'm1' });
    const r = line('bob', 'alice: noon', {
      replyTo: { msgid: 'm1', parent: parent({ id: p.id }) },
    });
    const w = mountWith([p, r]);
    const row = rowOf(w, r.id);
    // Quoted as IRC writes it, formatting dropped, as the first line of the
    // reply's own body.
    expect(row.find('.body .reply-quote .reply-text').text()).toBe('<alice> what time is it?');
    expect(row.find('.body .reply-quote .reply-mark').text()).toBe('╭─');
    expect(ownText(row)).toBe('noon');
    // A plain line has no quote.
    expect(rowOf(w, p.id).find('.reply-quote').exists()).toBe(false);
  });

  // The quote is part of the message, so a reply keeps its author's run going.
  it('continues its author’s run, quote and all', () => {
    useSettingsStore().values = { 'look.message.collapse_authors': true } as never;
    const first = line('bob', 'first thought');
    const r = line('bob', 'and a reply', { replyTo: { msgid: 'm1', parent: parent() } });
    const w = mountWith([first, r]);
    expect(rowOf(w, r.id).classes()).toContain('cont-author');
    expect(rowOf(w, r.id).find('.prefix').text()).toBe('');
    expect(rowOf(w, r.id).find('.reply-quote').exists()).toBe(true);
  });

  it('says the answered line is unavailable when it isn’t there', () => {
    const r = line('bob', 'lol same', { replyTo: { msgid: 'gone', parent: null } });
    const w = mountWith([r]);
    expect(rowOf(w, r.id).find('.reply-quote').classes()).toContain('missing');
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('original message unavailable');
  });

  it('won’t quote someone ignored since, even though the server sent the line', () => {
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
    const r = line('bob', 'alice: noon', { replyTo: { msgid: 'm1', parent: parent() } });
    const w = mountWith([r]);
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('original message unavailable');
    expect(rowOf(w, r.id).text()).not.toContain('what time');
    // With no quote naming her, the address is the only sign of who it's to.
    expect(ownText(rowOf(w, r.id))).toBe('alice: noon');
  });

  it('jumps to the answered line from the keyboard, and offers nothing when it’s gone', async () => {
    const jump = vi.spyOn(jumpIntent, 'emitJumpIntent');
    const p = line('alice', 'what time is it?', { msgid: 'm1' });
    const r = line('bob', 'noon', { replyTo: { msgid: 'm1', parent: parent({ id: p.id }) } });
    const gone = line('bob', 'lol', { replyTo: { msgid: 'x', parent: null } });
    const w = mountWith([p, r, gone]);
    const ctx = rowOf(w, r.id).find('.reply-quote');
    expect(ctx.attributes('role')).toBe('button');
    expect(ctx.attributes('tabindex')).toBe('0');
    await ctx.trigger('keydown', { key: 'Enter' });
    await ctx.trigger('keydown', { key: ' ' });
    expect(jump).toHaveBeenCalledTimes(2);
    expect(jump).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'jump', networkId: 1, target: '#chan', messageId: p.id }),
    );
    const missing = rowOf(w, gone.id).find('.reply-quote');
    expect(missing.attributes('role')).toBeUndefined();
    expect(missing.attributes('tabindex')).toBeUndefined();
    // Nothing to jump to, and the click stays with the quote all the same.
    const bubbled: Event[] = [];
    rowOf(w, gone.id).element.addEventListener('click', (e) => bubbled.push(e));
    await missing.trigger('click');
    expect(jump).toHaveBeenCalledTimes(2);
    expect(bubbled).toEqual([]);
    jump.mockRestore();
  });

  it('quotes a /me and a notice the way IRC writes them', () => {
    const a = line('bob', 'rip', {
      replyTo: { msgid: 'm1', parent: parent({ nick: 'carol', type: 'action', text: 'waves' }) },
    });
    const n = line('bob', 'thanks', {
      replyTo: { msgid: 'm2', parent: parent({ nick: 'ChanServ', type: 'notice', text: 'hi' }) },
    });
    const w = mountWith([a, n]);
    expect(rowOf(w, a.id).find('.reply-text').text()).toBe('* carol waves');
    expect(rowOf(w, n.id).find('.reply-text').text()).toBe('-ChanServ- hi');
  });

  // The tint follows the server's stamp, which is what the badge and the feed
  // count — not the parent, which can be gone by now.
  it('keeps a reply to you highlighted once the rules are evaluated live', () => {
    const rules = useHighlightRulesStore();
    rules.loaded = true;
    const toMe = line('bob', 'good question', {
      matched: true,
      replyToSelf: true,
      replyTo: { msgid: 'm1', parent: parent({ nick: 'me', self: true }) },
    });
    const parentGone = line('bob', 'still to you', {
      matched: true,
      replyToSelf: true,
      replyTo: { msgid: 'm3', parent: null },
    });
    const toAlice = line('bob', 'not you', { replyTo: { msgid: 'm2', parent: parent() } });
    const w = mountWith([toMe, parentGone, toAlice]);
    expect(rowOf(w, toMe.id).classes()).toContain('highlight');
    expect(rowOf(w, parentGone.id).classes()).toContain('highlight');
    expect(rowOf(w, toAlice.id).classes()).not.toContain('highlight');
  });

  it('starts a reply from the Reply action on a line with a msgid', async () => {
    const p = line('alice', 'what time is it?', { msgid: 'm1' });
    const w = mountWith([p]);
    const reply = rowOf(w, p.id)
      .findAll('.row-actions button')
      .find((b) => b.attributes('title')?.startsWith('Reply'));
    expect(reply).toBeTruthy();
    await reply!.trigger('click');
    expect(useRepliesStore().forKey(KEY)).toMatchObject({
      messageId: p.id,
      nick: 'alice',
      type: 'message',
      text: 'what time is it?',
    });
  });

  it('only addresses them when the line has no msgid to reply to', async () => {
    const p = line('alice', 'untagged network');
    const w = mountWith([p]);
    const reply = rowOf(w, p.id)
      .findAll('.row-actions button')
      .find((b) => b.attributes('title')?.startsWith('Reply'));
    await reply!.trigger('click');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
  });

  // #997: replying to yourself is a real reply with nobody to address.
  const replyToSelfButton = (w: VueWrapper, id: number) =>
    rowOf(w, id)
      .findAll('.row-actions button')
      .find((b) => b.attributes('title') === 'Reply to yourself');

  it('replies to your own line without addressing you', async () => {
    const address = vi.spyOn(composerOverlay, 'addressNick');
    const focus = vi.spyOn(composerOverlay, 'focusComposer');
    const cancel = vi.spyOn(composerOverlay, 'cancelComposerReply');
    const mine = line('me', 'the build is green', { msgid: 'm1' });
    const w = mountWith([mine]);
    useNetworksStore().states[1].canReact = true;
    await w.vm.$nextTick();
    const reply = replyToSelfButton(w, mine.id);
    expect(reply).toBeTruthy();
    await reply!.trigger('click');
    expect(useRepliesStore().forKey(KEY)).toMatchObject({
      messageId: mine.id,
      nick: 'me',
      self: true,
    });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(address).not.toHaveBeenCalled();
    // Nothing was pending, so there was nothing to take back.
    expect(cancel).not.toHaveBeenCalled();
  });

  // Reply on alice's line put `alice: ` in the draft; replying to yourself
  // instead must take it back out, or the line goes out addressed to her.
  it('drops a pending reply’s address when you switch to your own line', async () => {
    const cancel = vi
      .spyOn(composerOverlay, 'cancelComposerReply')
      .mockImplementation(() => useRepliesStore().cancel(KEY));
    const mine = line('me', 'the build is green', { msgid: 'm2' });
    const w = mountWith([mine]);
    useNetworksStore().states[1].canReact = true;
    useRepliesStore().start(KEY, {
      messageId: 1,
      nick: 'alice',
      type: 'message',
      text: 'is it?',
      addressed: true,
    });
    await w.vm.$nextTick();
    await replyToSelfButton(w, mine.id)!.trigger('click');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(useRepliesStore().forKey(KEY)).toMatchObject({ messageId: mine.id, self: true });
  });

  // An address the user typed is theirs: switching leaves it alone.
  it('leaves a pending reply alone that put no address in', async () => {
    const cancel = vi.spyOn(composerOverlay, 'cancelComposerReply');
    const mine = line('me', 'the build is green', { msgid: 'm2' });
    const w = mountWith([mine]);
    useNetworksStore().states[1].canReact = true;
    useRepliesStore().start(KEY, { messageId: 1, nick: 'alice', type: 'message', text: 'is it?' });
    await w.vm.$nextTick();
    await replyToSelfButton(w, mine.id)!.trigger('click');
    expect(cancel).not.toHaveBeenCalled();
  });

  // The bar was built while the line could take a reply, and it can't by the
  // click: no reply starts, so there's nothing to put the caret there for.
  it('does nothing on your own line once it can no longer take a reply', async () => {
    const focus = vi.spyOn(composerOverlay, 'focusComposer');
    const mine = line('me', 'the build is green', { msgid: 'm1' });
    const w = mountWith([mine]);
    useNetworksStore().states[1].canReact = true;
    await w.vm.$nextTick();
    const reply = replyToSelfButton(w, mine.id)!;
    useBuffersStore().buffers[KEY].messages[0].msgid = undefined;
    await reply.trigger('click');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });

  // The bar was built while the network could carry the tag; by the click it
  // can't, and your own line has no address for the line to fall back on.
  it('does nothing on your own line once the network can’t carry the reply', async () => {
    const focus = vi.spyOn(composerOverlay, 'focusComposer');
    const mine = line('me', 'the build is green', { msgid: 'm1' });
    const w = mountWith([mine]);
    useNetworksStore().states[1].canReact = true;
    await w.vm.$nextTick();
    const reply = replyToSelfButton(w, mine.id)!;
    useNetworksStore().states[1].canReact = false;
    await reply.trigger('click');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });

  // Someone else's line keeps its fallback: the address says who it answers.
  it('still starts a reply to someone else when the tag can’t go out', async () => {
    const p = line('alice', 'what time is it?', { msgid: 'm1' });
    const w = mountWith([p]);
    const reply = rowOf(w, p.id)
      .findAll('.row-actions button')
      .find((b) => b.attributes('title') === 'Reply to alice');
    await reply!.trigger('click');
    expect(useRepliesStore().forKey(KEY)).toMatchObject({ messageId: p.id, nick: 'alice' });
  });

  // No reply tag would go out, and your own line has no address to fall back on.
  it('offers no Reply on your own line when the network can’t carry it', () => {
    const mine = line('me', 'the build is green', { msgid: 'm1' });
    const w = mountWith([mine]);
    expect(replyToSelfButton(w, mine.id)).toBeUndefined();
  });

  // Without a msgid there's nothing a Reply could do on your own line.
  it('offers no Reply on your own line without a msgid', () => {
    const mine = line('me', 'untagged network');
    const w = mountWith([mine]);
    const titles = rowOf(w, mine.id)
      .findAll('.row-actions button')
      .map((b) => b.attributes('title'));
    expect(titles.some((t) => t?.startsWith('Reply'))).toBe(false);
  });
});

// #996: a quoted line from a relay bot shows the person inside its envelope,
// as the timeline shows that line itself.
describe('MessageList — replies to relayed lines', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  const markRelay = (nick: string) => {
    useRelayBotsStore().byKey[`1::${nick.toLowerCase()}`] = { nick, pattern: '' };
  };
  const ignore = (mask: string) => {
    useIgnoresStore().global = [
      {
        id: 1,
        createdAt: '',
        mask,
        channels: null,
        pattern: null,
        patternKind: 'substr',
        levels: ['ALL'],
        isExcept: false,
        expiresAt: null,
      },
    ];
  };
  // The bridge's line, and a reply to it quoting it as stored.
  function relayed(envelope: string, replyText = 'alice: the release one') {
    const p = line('bridgebot', envelope, { msgid: 'm1' });
    const r = line('bob', replyText, {
      replyTo: {
        msgid: 'm1',
        parent: parent({
          id: p.id,
          nick: 'bridgebot',
          text: envelope,
          userhost: 'bridgebot!~b@host',
        }),
      },
    });
    return { p, r };
  }

  it('quotes the person, not the bridge, and drops the address that names her', () => {
    markRelay('bridgebot');
    const { p, r } = relayed('[Discord] <alice> which branch?');
    const w = mountWith([p, r]);
    // The line itself, as the timeline shows it.
    expect(rowOf(w, p.id).find('.prefix').text()).toContain('alice');
    // With the `[source]` label the line itself carries in the timeline.
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('<alice> [Discord] which branch?');
    expect(rowOf(w, r.id).find('.reply-relay').attributes('title')).toBe('Relayed via bridgebot');
    expect(ownText(rowOf(w, r.id))).toBe('the release one');
  });

  // halloy and goguma know nothing of relay marks: their reply addresses the
  // bridge by the nick they see.
  it('drops an address that names the bridge, too', () => {
    markRelay('bridgebot');
    const { p, r } = relayed('<alice> which branch?', 'bridgebot: the release one');
    const w = mountWith([p, r]);
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('<alice> which branch?');
    expect(rowOf(w, r.id).find('.reply-relay').exists()).toBe(false);
    expect(ownText(rowOf(w, r.id))).toBe('the release one');
  });

  // The quote colours the person as the timeline row does: from their nick,
  // since the stored `self` describes the bot's line.
  it('colours a relayed you as the timeline row does', () => {
    useSettingsStore().values = { 'look.nick.self_color': 'rgb(1, 2, 3)' } as never;
    markRelay('bridgebot');
    const { p, r } = relayed('<me> which branch?', 'this one');
    const w = mountWith([p, r]);
    const rowNick = rowOf(w, p.id).find('.prefix .nick-ref').element as HTMLElement;
    const quoted = rowOf(w, r.id).find('.reply-quote .nick-ref').element as HTMLElement;
    expect(rowNick.style.color).toBe('rgb(1, 2, 3)');
    expect(quoted.style.color).toBe('rgb(1, 2, 3)');
  });

  it('quotes the envelope as it is when the bot isn’t marked', () => {
    const { p, r } = relayed('<alice> which branch?');
    const w = mountWith([p, r]);
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('<bridgebot> <alice> which branch?');
    expect(ownText(rowOf(w, r.id))).toBe('alice: the release one');
  });

  it('follows a chain of marked bridges to the person', () => {
    markRelay('bridgebot');
    markRelay('|');
    const { p, r } = relayed('<|> <alice[m]/OFTC> which branch?', 'alice[m]/OFTC: this one');
    const w = mountWith([p, r]);
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('<alice[m]/OFTC> which branch?');
    expect(ownText(rowOf(w, r.id))).toBe('this one');
  });

  // The quote is judged as its line is: the timeline judges a relayed line as
  // the bot's (no ignore rule reaches inside an envelope), so the quote does too.
  it('shows or hides the quote exactly as the timeline does the line', () => {
    markRelay('bridgebot');
    ignore('alice!*@*');
    const shown = relayed('<alice> which branch?');
    let w = mountWith([shown.p, shown.r]);
    expect(rowOf(w, shown.p.id).exists()).toBe(true);
    expect(rowOf(w, shown.r.id).find('.reply-text').text()).toBe('<alice> which branch?');
    w.unmount();

    ignore('bridgebot!*@*');
    nextId = 1;
    const hidden = relayed('<alice> which branch?');
    w = mountWith([hidden.p, hidden.r]);
    expect(rowOf(w, hidden.p.id).exists()).toBe(false);
    expect(rowOf(w, hidden.r.id).find('.reply-text').text()).toBe('original message unavailable');
    expect(ownText(rowOf(w, hidden.r.id))).toBe('alice: the release one');
    wrapper = w;
  });

  // The timeline unwraps only a bot's plain messages, never a notice or a /me,
  // and never your own line; the quote keeps to the same lines.
  it('leaves a bot’s notice as it is, as the timeline does', () => {
    markRelay('bridgebot');
    const p = line('bridgebot', '<alice> which branch?', { msgid: 'm1', type: 'notice' });
    const r = line('bob', 'this one', {
      replyTo: {
        msgid: 'm1',
        parent: parent({ id: p.id, nick: 'bridgebot', type: 'notice', text: p.text }),
      },
    });
    const w = mountWith([p, r]);
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('-bridgebot- <alice> which branch?');
  });

  it('leaves your own line as it is, even under a marked nick', () => {
    markRelay('me');
    const p = line('me', '<alice> which branch?', { msgid: 'm1' });
    const r = line('bob', 'this one', {
      replyTo: {
        msgid: 'm1',
        parent: parent({ id: p.id, nick: 'me', text: p.text, self: true }),
      },
    });
    const w = mountWith([p, r]);
    expect(rowOf(w, p.id).find('.prefix').text()).toContain('me');
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('<me> <alice> which branch?');
  });

  // The reply can come through the bridge too: it's her words, addressed to
  // whoever she answers.
  it('reads a relayed reply as the person who sent it', () => {
    markRelay('bridgebot');
    const p = line('alice', 'which branch?', { msgid: 'm1' });
    const r = line('bridgebot', '<carol> alice: the release one', {
      replyTo: { msgid: 'm1', parent: parent({ id: p.id, text: 'which branch?' }) },
    });
    const w = mountWith([p, r]);
    expect(rowOf(w, r.id).find('.prefix').text()).toContain('carol');
    expect(rowOf(w, r.id).find('.reply-text').text()).toBe('<alice> which branch?');
    expect(ownText(rowOf(w, r.id))).toBe('the release one');
  });
});
