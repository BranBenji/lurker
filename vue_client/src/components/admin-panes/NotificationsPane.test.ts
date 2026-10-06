// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The relay checkbox flips itself before the change is confirmed or saved, and
// Vue can't put it back because the bound value never moved. A cancelled or
// failed change must leave it showing the truth.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import { useAdminStore, type AdminPushConfig } from '../../stores/admin.js';
import NotificationsPane from './NotificationsPane.vue';

function config(over: Partial<AdminPushConfig['relay']> = {}, transports = ['webpush']) {
  return {
    publicKey: 'BPubKeyBase64url',
    transports,
    relay: { url: 'https://push.lurker.chat', enabled: false, devices: 0, ...over },
  } satisfies AdminPushConfig;
}

let setRelay: ReturnType<typeof vi.fn<(enabled: boolean) => Promise<number>>>;

function stubConfirm(answer: boolean) {
  const fn = vi.fn<(message?: string) => boolean>(() => answer);
  window.confirm = fn as unknown as typeof window.confirm;
  return fn;
}

async function mountPane(initial: AdminPushConfig): Promise<VueWrapper> {
  const store = useAdminStore();
  store.fetchPush = vi.fn<() => Promise<void>>(async () => {
    store.push = initial;
  });
  setRelay = vi.fn<(enabled: boolean) => Promise<number>>().mockResolvedValue(0);
  store.setPushRelayEnabled = setRelay as unknown as typeof store.setPushRelayEnabled;
  const wrapper = mount(NotificationsPane);
  await flushPromises();
  return wrapper;
}

function checkbox(wrapper: VueWrapper): HTMLInputElement {
  return wrapper.find('input[type="checkbox"]').element as HTMLInputElement;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('NotificationsPane', () => {
  it('shows the key to register and no relay talk on a server with native push', async () => {
    const w = await mountPane(config({}, ['webpush', 'apns', 'fcm']));
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    expect(w.text()).toContain('directly');
  });

  it('shows the server key on a self-hosted server', async () => {
    const w = await mountPane(config());
    expect(w.find('code.key').text()).toBe('BPubKeyBase64url');
    expect(checkbox(w).checked).toBe(false);
  });

  it('turns the relay on without asking', async () => {
    const confirm = stubConfirm(true);
    const w = await mountPane(config());
    await w.find('input[type="checkbox"]').setValue(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(setRelay).toHaveBeenCalledWith(true);
  });

  it('asks before turning off a relay devices depend on, and stays on if cancelled', async () => {
    const confirm = stubConfirm(false);
    const w = await mountPane(config({ enabled: true, devices: 3 }));
    await w.find('input[type="checkbox"]').setValue(false);
    expect(confirm.mock.calls[0][0]).toContain('3 devices');
    expect(setRelay).not.toHaveBeenCalled();
    expect(checkbox(w).checked).toBe(true);
  });

  it('puts the checkbox back when the save fails', async () => {
    stubConfirm(true);
    const w = await mountPane(config());
    setRelay.mockRejectedValueOnce(new Error('nope'));
    await w.find('input[type="checkbox"]').setValue(true);
    await flushPromises();
    expect(checkbox(w).checked).toBe(false);
    expect(w.text()).toContain('nope');
  });
});
