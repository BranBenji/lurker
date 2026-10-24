// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The flood protection switch in the network form (#1193): on unless the
// network says off, under Advanced, with a warning only while it is off, and
// carried on the save request both ways.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { useNetworksStore, type Network } from '../stores/networks.js';
import { useNetworkPresetsStore } from '../stores/networkPresets.js';
import NetworkForm from './NetworkForm.vue';

let mounted: ReturnType<typeof mount>[] = [];

function network(extra: Record<string, unknown> = {}): Network {
  return {
    id: 7,
    name: 'Libera',
    host: 'irc.libera.chat',
    port: 6697,
    nick: 'nick',
    tls: true,
    autoconnect: true,
    trusted_certificates: true,
    ...extra,
  } as Network;
}

async function open(extra: Record<string, unknown> = {}) {
  const form = mount(NetworkForm, { props: { network: network(extra) } });
  mounted.push(form);
  // Already open for a network with something advanced set.
  const toggle = form.findAll('button').find((b) => b.text().startsWith('+ Advanced options'));
  if (toggle) await toggle.trigger('click');
  return form;
}

function floodBox(form: ReturnType<typeof mount>) {
  return form
    .findAll('label.check')
    .find((l) => l.text().includes('Flood protection'))!
    .find('input[type="checkbox"]');
}

const WARNING = 'Lines go out as fast as you send them';

describe('NetworkForm — flood protection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(useNetworkPresetsStore(), 'fetchAll').mockResolvedValue(undefined);
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('is on, without a warning, for a network that never said otherwise', async () => {
    const form = await open();
    expect((floodBox(form).element as HTMLInputElement).checked).toBe(true);
    expect(form.text()).not.toContain(WARNING);
  });

  it('opens Advanced by itself and warns when the network has it off', async () => {
    const form = mount(NetworkForm, { props: { network: network({ flood_protection: false }) } });
    mounted.push(form);
    expect((floodBox(form).element as HTMLInputElement).checked).toBe(false);
    expect(form.text()).toContain(WARNING);
  });

  it('turning it off goes on the save request, and the warning shows at once', async () => {
    const store = useNetworksStore();
    const update = vi.spyOn(store, 'update').mockResolvedValue(undefined as never);
    const form = await open();
    await floodBox(form).setValue(false);
    expect(form.text()).toContain(WARNING);
    await form.find('form').trigger('submit');
    expect(update).toHaveBeenCalledWith(7, expect.objectContaining({ flood_protection: false }));
  });

  it('turning it back on goes on the save request too', async () => {
    const store = useNetworksStore();
    const update = vi.spyOn(store, 'update').mockResolvedValue(undefined as never);
    const form = await open({ flood_protection: false });
    await floodBox(form).setValue(true);
    expect(form.text()).not.toContain(WARNING);
    await form.find('form').trigger('submit');
    expect(update).toHaveBeenCalledWith(7, expect.objectContaining({ flood_protection: true }));
  });
});
