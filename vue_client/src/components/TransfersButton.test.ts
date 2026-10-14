// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The Transfers button (#1084), one component for the desktop rail and the
// mobile top bar, which each carried their own copy.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../api.js', () => ({
  api: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ transfers: [] })),
}));

import TransfersButton from './TransfersButton.vue';
import { useDccStore } from '../stores/dcc.js';

type Transfer = ReturnType<typeof useDccStore>['transfers'][number];
const row = (id: number, state: string) => ({ id, state }) as unknown as Transfer;

beforeEach(() => setActivePinia(createPinia()));

describe('TransfersButton', () => {
  it('stays hidden until a transfer exists', () => {
    expect(mount(TransfersButton).find('button').exists()).toBe(false);
  });

  it('shows once there is a transfer, and takes the class its view gives it', async () => {
    const w = mount(TransfersButton, { attrs: { class: 'icon' } });
    useDccStore().transfers = [row(1, 'completed')];
    await w.vm.$nextTick();
    const b = w.find('button');
    expect(b.classes()).toEqual(expect.arrayContaining(['icon', 'dcc-btn']));
    expect(b.classes()).not.toContain('pending');
    expect(b.attributes('title')).toBe('DCC transfers');
  });

  it('turns warn-colored and says how many offers wait', async () => {
    const w = mount(TransfersButton);
    useDccStore().transfers = [row(1, 'pending_approval'), row(2, 'pending_approval')];
    await w.vm.$nextTick();
    expect(w.find('button').classes()).toContain('pending');
    expect(w.find('button').attributes('title')).toBe('DCC transfers — 2 awaiting approval');
  });

  it('opens the panel on click', async () => {
    const w = mount(TransfersButton);
    const dcc = useDccStore();
    dcc.transfers = [row(1, 'completed')];
    await w.vm.$nextTick();
    await w.find('button').trigger('click');
    expect(dcc.panelOpen).toBe(true);
  });
});
