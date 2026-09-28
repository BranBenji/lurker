// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// relayBots.unwrap: a line from a marked relay bot as the speaker inside its
// envelope — what the timeline's rows (#277, #801) and a reply's quote (#996)
// both read relayed lines through.

import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useRelayBotsStore } from './relayBots.js';

const msg = (nick: string, text: string, over: Record<string, unknown> = {}) => ({
  type: 'message',
  nick,
  text,
  self: false,
  ...over,
});

function mark(networkId: number, nick: string, pattern = '') {
  useRelayBotsStore().byKey[`${networkId}::${nick.toLowerCase()}`] = { nick, pattern };
}

describe('relayBots.unwrap', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('leaves a line from a nick that isn’t marked alone', () => {
    expect(useRelayBotsStore().unwrap(1, msg('bridgebot', '<alice> hi'))).toBeNull();
  });

  it('reads a marked bot’s envelope, case-insensitively and per network', () => {
    mark(1, 'BridgeBot');
    const relay = useRelayBotsStore();
    expect(relay.unwrap(1, msg('bridgebot', '[Discord] <alice> hi'))).toEqual({
      source: 'Discord',
      nick: 'alice',
      text: 'hi',
    });
    expect(relay.unwrap(2, msg('bridgebot', '<alice> hi'))).toBeNull();
    // Its own voice, not an envelope.
    expect(relay.unwrap(1, msg('bridgebot', 'reconnected to Discord'))).toBeNull();
  });

  // Relays bridge speech as PRIVMSG; a notice or /me keeps its own rendering,
  // and your own line is never someone else's envelope.
  it('reads only a plain message from someone else', () => {
    mark(1, 'bridgebot');
    mark(1, 'me');
    const relay = useRelayBotsStore();
    expect(relay.unwrap(1, msg('bridgebot', '<alice> hi', { type: 'notice' }))).toBeNull();
    expect(relay.unwrap(1, msg('bridgebot', '<alice> hi', { type: 'action' }))).toBeNull();
    expect(relay.unwrap(1, msg('me', '<alice> hi', { self: true }))).toBeNull();
    expect(relay.unwrap(null, msg('bridgebot', '<alice> hi'))).toBeNull();
    expect(relay.unwrap(1, msg('bridgebot', '<alice> hi'))).not.toBeNull();
  });

  it('uses the bot’s own template', () => {
    mark(1, 'tg', '{nick}: {message}');
    expect(useRelayBotsStore().unwrap(1, msg('tg', 'alice: hi'))).toMatchObject({
      nick: 'alice',
      text: 'hi',
    });
  });

  // #801: a relay of a relay lands on the person, but only through hops that
  // are themselves marked — an unmarked inner `<nick>` is someone quoting.
  it('follows a chain through marked hops only', () => {
    mark(1, 'nR');
    mark(1, '|');
    const relay = useRelayBotsStore();
    expect(
      relay.unwrap(1, msg('nR', '[IRC-nERDs] <|> <yrdsb[m]/OFTC> is there a discord')),
    ).toEqual({
      source: 'IRC-nERDs',
      nick: 'yrdsb[m]/OFTC',
      text: 'is there a discord',
    });
    expect(relay.unwrap(1, msg('nR', '<carol> <dave> was quoted'))).toEqual({
      source: null,
      nick: 'carol',
      text: '<dave> was quoted',
    });
  });
});
