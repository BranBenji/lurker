// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  builtinNetworks,
  suggestedChannels,
  LURKER_CHANNEL,
  LURKER_TAG,
  type NetworkPreset,
} from './builtinNetworks.js';

function net(overrides: Partial<NetworkPreset> = {}): NetworkPreset {
  return {
    name: 'Example',
    host: 'irc.example.org',
    port: 6697,
    tls: true,
    website: 'https://example.org',
    users: 100,
    channels: 10,
    saslLikelyRequired: false,
    tags: [],
    ...overrides,
  };
}

describe('suggestedChannels', () => {
  it('offers nothing for a network we know no channel for', () => {
    // The honest answer, and the common one. Callers turn an empty list into a
    // placeholder — never into a channel we one-click-join a new user into.
    expect(suggestedChannels(net())).toStrictEqual([]);
  });

  it('offers the network’s own channel when we have one (#308)', () => {
    expect(suggestedChannels(net({ defaultChannel: '#example' }))).toStrictEqual(['#example']);
  });

  it('offers #lurker for a lurker-tagged network', () => {
    expect(suggestedChannels(net({ tags: [LURKER_TAG] }))).toStrictEqual([LURKER_CHANNEL]);
  });

  it('leads with #lurker when a network has both', () => {
    // A new user is better served by the room where they can get help with the
    // client than by the network's general chat.
    expect(suggestedChannels(net({ tags: [LURKER_TAG], defaultChannel: '#libera' }))).toStrictEqual(
      [LURKER_CHANNEL, '#libera'],
    );
  });

  it('does not list the same channel twice when defaultChannel IS #lurker', () => {
    const both = net({ tags: [LURKER_TAG], defaultChannel: '#Lurker' });
    expect(suggestedChannels(both)).toStrictEqual([LURKER_CHANNEL]);
  });

  // An admin-defined instance preset (#298) is the admin's call, full stop. We
  // don't append #lurker to it: they run the place, and a corporate instance
  // doesn't want its new hires auto-joined into a public support channel.
  it('takes an instance preset’s channels verbatim, without adding #lurker', () => {
    const preset = net({
      isInstance: true,
      recommendedChannels: ['#general', '#random'],
      tags: [LURKER_TAG],
    });
    expect(suggestedChannels(preset)).toStrictEqual(['#general', '#random']);
  });

  it('offers nothing for an instance preset with no recommended channels', () => {
    expect(suggestedChannels(net({ isInstance: true }))).toStrictEqual([]);
  });
});

describe('builtinNetworks order', () => {
  it('leads with the first-party network, then lurker-tagged ones by size', () => {
    expect(builtinNetworks[0]?.firstParty).toBe(true);
    expect(builtinNetworks[0]?.host).toBe('irc.lurker.chat');
    // The pin, not the count, puts it first: its users figure is far below Libera's.
    expect(builtinNetworks[0]!.users!).toBeLessThan(builtinNetworks[1]!.users!);
    const second = builtinNetworks[1]!;
    expect(second.firstParty).toBeUndefined();
    expect(second.tags).toContain(LURKER_TAG);
  });

  it('carries exactly one first-party network', () => {
    expect(builtinNetworks.filter((n) => n.firstParty).map((n) => n.name)).toStrictEqual([
      'Lurker.Chat',
    ]);
  });

  it('offers #lurker then #lobby for the first-party network', () => {
    expect(suggestedChannels(builtinNetworks[0]!)).toStrictEqual([LURKER_CHANNEL, '#lobby']);
  });
});

describe('builtinNetworks data', () => {
  // These land a brand-new user in a channel on their first ever session, so a
  // malformed one is a first-impression bug. Cheap to assert, so assert it.
  it('every defaultChannel is a well-formed channel name', () => {
    const withChannel = builtinNetworks.filter((n) => n.defaultChannel !== undefined);
    expect(withChannel.length).toBeGreaterThan(0);
    // Collected rather than asserted per-item so a failure reports *which*
    // networks are malformed, not just the first one.
    const malformed = withChannel
      .filter((n) => !/^#{1,2}[^\s,]+$/.test(n.defaultChannel!))
      .map((n) => `${n.name}: ${n.defaultChannel}`);
    expect(malformed).toStrictEqual([]);
  });

  it('has no duplicate hosts', () => {
    const hosts = builtinNetworks.map((n) => n.host.toLowerCase());
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
