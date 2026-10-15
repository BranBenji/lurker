// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The ident surface follows the server's identdEnabled, which is tri-state
// since #1138: in engine mode ident runs on the engine, out of the server's
// sight, so it answers null, and the pane must not take that as "off" — hiding
// the editor from an operator whose engine does answer ident was the bug.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import { useAdminStore } from '../../stores/admin.js';
import UsersPane from './UsersPane.vue';

function mountPane(identdEnabled: boolean | null): VueWrapper {
  const store = useAdminStore();
  store.users = [
    {
      id: 2,
      username: 'bob',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      ident: null,
      effectiveIdent: 'bob',
      identConflict: true,
    },
  ];
  store.usersLoaded = true;
  store.identdEnabled = identdEnabled;
  store.fetchUsers = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  return mount(UsersPane);
}

const editor = (w: VueWrapper) => w.findAll('button').filter((b) => b.text() === 'ident');
const banner = (w: VueWrapper) => w.text().includes("Networks can't ask this server");
const unconfirmed = (w: VueWrapper) => w.text().includes("which this server can't check");

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('UsersPane ident surface (#1138)', () => {
  it('offers the editor and the tag when ident is running', () => {
    const w = mountPane(true);
    expect(editor(w)).toHaveLength(1);
    expect(w.find('.ident-tag').exists()).toBe(true);
    expect(w.find('.conflict-tag').exists()).toBe(true);
    expect(banner(w)).toBe(false);
    expect(unconfirmed(w)).toBe(false);
  });

  it('hides them and says how to turn ident on when nothing answers', () => {
    const w = mountPane(false);
    expect(editor(w)).toHaveLength(0);
    expect(w.find('.ident-tag').exists()).toBe(false);
    expect(w.find('.conflict-tag').exists()).toBe(false);
    expect(banner(w)).toBe(true);
    expect(unconfirmed(w)).toBe(false);
  });

  it("keeps the editor, and says it can't confirm ident, when the server can't tell", () => {
    const w = mountPane(null);
    expect(editor(w)).toHaveLength(1);
    expect(w.find('.ident-tag').exists()).toBe(true);
    // A duplicate is still worth flagging: if ident does run, it's ambiguous.
    expect(w.find('.conflict-tag').exists()).toBe(true);
    expect(banner(w)).toBe(false);
    expect(unconfirmed(w)).toBe(true);
  });
});
