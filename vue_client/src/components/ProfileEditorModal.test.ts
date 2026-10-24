// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The profile editor (#1189): what it shows, and what Save sends — only the
// fields that changed, so a key set elsewhere and left alone isn't claimed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

type Call = { url: string; method?: string; body?: unknown };
const calls: Call[] = [];
let reply: unknown = null;
vi.mock('../api.js', () => ({
  api: (url: string, opts: { method?: string; body?: unknown } = {}) => {
    calls.push({ url, ...opts });
    return Promise.resolve(reply);
  },
}));

import ProfileEditorModal from './ProfileEditorModal.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useProfileEditor } from '../composables/useProfileEditor.js';

const NET = 7;
const LIMITS = { maxSubs: 10, maxKeys: 10, maxValueBytes: null, beforeConnect: false };

function setNetwork(state: Record<string, unknown>) {
  const networks = useNetworksStore();
  networks.networks = [{ id: NET, name: 'ergo' } as never, { id: 8, name: 'other' } as never];
  networks.states[NET] = { networkId: NET, channels: [], ...state } as never;
}

async function open() {
  useProfileEditor().open(NET);
  const wrapper = mount(ProfileEditorModal, { props: { networkId: NET }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const input = (wrapper: Awaited<ReturnType<typeof open>>, title: string) =>
  wrapper
    .findAll('label')
    .find((l) => l.find('.title').text() === title)!
    .find('input');

describe('profile editor', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    calls.length = 0;
  });

  it("fills saved keys, the server's for the rest, and saves what changed or isn't saved", async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = {
      values: { 'display-name': 'Saved Name' },
      // A saved unset stays empty, whatever the server still has.
      unset: ['status'],
      live: { 'display-name': 'Saved Name', pronouns: 'from halloy', status: 'stale' },
      avatarPreview: null,
    };
    const wrapper = await open();
    expect((input(wrapper, 'Display name').element as HTMLInputElement).value).toBe('Saved Name');
    expect((input(wrapper, 'Pronouns').element as HTMLInputElement).value).toBe('from halloy');
    expect((input(wrapper, 'Status').element as HTMLInputElement).value).toBe('');

    await input(wrapper, 'Status').setValue('  lunch ');
    await input(wrapper, 'Display name').setValue('');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      url: `/api/networks/${NET}/metadata`,
      method: 'PUT',
      // The server's pronouns, shown and kept, are saved now too; a saved
      // field left alone, and an empty one never saved, aren't sent.
      body: { values: { 'display-name': null, pronouns: 'from halloy', status: 'lunch' } },
    });
    expect(useProfileEditor().networkId.value).toBeNull();
  });

  it('Clear unsets every saved key', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: { 'display-name': 'X' }, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    const clear = wrapper.findAll('button').find((b) => b.text() === 'Clear')!;
    await clear.trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toEqual({ url: `/api/networks/${NET}/metadata`, method: 'DELETE' });
    expect(useProfileEditor().networkId.value).toBeNull();
  });

  it('opens only on a connected network that carries metadata', () => {
    const editor = useProfileEditor();
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    expect(editor.canOpen(NET)).toBe(true);
    setNetwork({ state: 'connected', metadataLimits: { ...LIMITS, maxKeys: 0 } });
    expect(editor.canOpen(NET)).toBe(false);
    setNetwork({ state: 'connected', metadataLimits: null });
    expect(editor.canOpen(NET)).toBe(false);
    setNetwork({ state: 'disconnected', metadataLimits: LIMITS });
    expect(editor.canOpen(NET)).toBe(false);
  });

  it('greys, keeping what was typed, when the network drops while it is open', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    await input(wrapper, 'Status').setValue('lunch');
    useNetworksStore().states[NET]!.state = 'disconnected';
    await flushPromises();
    expect(input(wrapper, 'Status').attributes('disabled')).toBeDefined();
    expect((input(wrapper, 'Status').element as HTMLInputElement).value).toBe('lunch');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it("copies another network's saved profile into the form", async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    // Saved there, or only on that server: both copy.
    reply = {
      values: { pronouns: 'they/them' },
      unset: [],
      live: { status: 'on that server' },
      avatarPreview: null,
    };
    await wrapper.find('select').setValue('8');
    await flushPromises();
    expect(calls.at(-1)!.url).toBe('/api/networks/8/metadata');
    expect((input(wrapper, 'Pronouns').element as HTMLInputElement).value).toBe('they/them');
    expect((input(wrapper, 'Status').element as HTMLInputElement).value).toBe('on that server');
  });
});
