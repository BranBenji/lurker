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

  it("fills saved keys, the server's for the rest, and saves only what changed", async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = {
      values: { 'display-name': 'Saved Name' },
      live: { 'display-name': 'Saved Name', pronouns: 'from halloy' },
      avatarPreview: null,
    };
    const wrapper = await open();
    expect((input(wrapper, 'Display name').element as HTMLInputElement).value).toBe('Saved Name');
    expect((input(wrapper, 'Pronouns').element as HTMLInputElement).value).toBe('from halloy');

    await input(wrapper, 'Status').setValue('  lunch ');
    await input(wrapper, 'Display name').setValue('');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      url: `/api/networks/${NET}/metadata`,
      method: 'PUT',
      body: { values: { 'display-name': null, status: 'lunch' } },
    });
    expect(useProfileEditor().networkId.value).toBeNull();
  });

  it("is greyed, and says why, on a network that can't carry it", async () => {
    setNetwork({ state: 'connected', metadataLimits: { ...LIMITS, maxKeys: 0 } });
    reply = { values: {}, live: null, avatarPreview: null };
    const wrapper = await open();
    expect(wrapper.find('.hint').text()).toMatch(/doesn't keep metadata/);
    expect(input(wrapper, 'Status').attributes('disabled')).toBeDefined();
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it('saves for later on a network that is not connected', async () => {
    setNetwork({ state: 'disconnected' });
    reply = { values: {}, live: null, avatarPreview: null };
    const wrapper = await open();
    expect(wrapper.find('.hint').text()).toMatch(/set when it connects/);
    expect(input(wrapper, 'Status').attributes('disabled')).toBeUndefined();
  });

  it("copies another network's saved profile into the form", async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, live: {}, avatarPreview: null };
    const wrapper = await open();
    reply = { values: { pronouns: 'they/them' }, live: null, avatarPreview: null };
    await wrapper.find('select').setValue('8');
    await flushPromises();
    expect(calls.at(-1)!.url).toBe('/api/networks/8/metadata');
    expect((input(wrapper, 'Pronouns').element as HTMLInputElement).value).toBe('they/them');
  });
});
