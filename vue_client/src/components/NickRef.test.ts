// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Whether a nick shows in the user's own colour: guessed from the open
// buffer's network nick, unless the caller knows (#998 — a reply's quote in a
// search hit can come from another network).

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import NickRef from './NickRef.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';

const SELF = 'rgb(1, 2, 3)';

function openBufferAs(nick: string) {
  const networks = useNetworksStore();
  networks.states = { 1: { nick, state: 'connected' } } as never;
  useBuffersStore().ensure(1, '#chan', 9);
  networks.activeKey = '1::#chan';
}

const colour = (props: Record<string, unknown>) =>
  (mount(NickRef, { props: props as never }).element as HTMLElement).style.color;

describe('NickRef — your own nick', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSettingsStore().values = { 'look.nick.self_color': SELF } as never;
    openBufferAs('me');
  });

  // Without the prop the guess still runs — an absent Boolean prop must not
  // read as "not you".
  it('guesses from the open buffer’s nick when not told', () => {
    expect(colour({ nick: 'me' })).toBe(SELF);
    expect(colour({ nick: 'alice' })).not.toBe(SELF);
  });

  it('takes the caller’s word when told', () => {
    // Your line under another network's nick.
    expect(colour({ nick: 'me_', self: true })).toBe(SELF);
    // Someone elsewhere who happens to have your nick here.
    expect(colour({ nick: 'me', self: false })).not.toBe(SELF);
  });
});

// #1032: the glyph and its colour come from the network's PREFIX.
describe('NickRef — mode glyph', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    openBufferAs('me');
  });

  const glyph = (props: Record<string, unknown>) =>
    mount(NickRef, { props: { nick: 'alice', showPrefix: true, ...props } as never }).find(
      '.mode-glyph',
    );

  it("shows the network's symbol, coloured by rank", () => {
    const prefix = [
      { mode: 'Y', symbol: '!' },
      { mode: 'o', symbol: '@' },
    ];
    expect(glyph({ modes: ['Y'], prefix }).text()).toBe('!');
    expect(glyph({ modes: ['Y'], prefix }).classes()).toContain('mode-owner');
    expect(glyph({ modes: ['o'], prefix: [{ mode: 'o', symbol: '*' }] }).text()).toBe('*');
    expect(glyph({ modes: ['o'], prefix: [{ mode: 'o', symbol: '*' }] }).classes()).toContain(
      'mode-op',
    );
  });

  it('falls back to the conventional table without a PREFIX', () => {
    expect(glyph({ modes: ['v'] }).text()).toBe('+');
    expect(glyph({ modes: ['v'] }).classes()).toContain('mode-voice');
  });
});
