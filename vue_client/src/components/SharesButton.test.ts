// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The Shares button (#1085), one component for the desktop rail and the
// mobile top bar. It opens the files window, and warns while a DCC offer
// waits for an answer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../api.js', () => ({
  api: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ transfers: [] })),
}));

import SharesButton from './SharesButton.vue';
import { useDccStore } from '../stores/dcc.js';

type Transfer = ReturnType<typeof useDccStore>['transfers'][number];
const row = (id: number, state: string) => ({ id, state }) as unknown as Transfer;

beforeEach(() => setActivePinia(createPinia()));

describe('SharesButton', () => {
  it('is always there, and takes the class its view gives it', () => {
    const b = mount(SharesButton, { attrs: { class: 'icon' } }).find('button');
    expect(b.classes()).toEqual(expect.arrayContaining(['icon', 'shares-btn']));
    expect(b.classes()).not.toContain('pending');
    expect(b.attributes('title')).toBe('Shares');
  });

  it('turns warn-colored and says how many offers wait', async () => {
    const w = mount(SharesButton);
    useDccStore().transfers = [row(1, 'pending_approval'), row(2, 'pending_approval')];
    await w.vm.$nextTick();
    expect(w.find('button').classes()).toContain('pending');
    expect(w.find('button').attributes('title')).toBe('Shares — 2 DCC offers waiting');
  });

  it('opens the window on shares, or on DCC when an offer waits', async () => {
    const w = mount(SharesButton);
    const dcc = useDccStore();
    await w.find('button').trigger('click');
    expect(dcc.panelOpen).toBe(true);
    expect(dcc.panelTab).toBe('shares');
    dcc.close();
    dcc.transfers = [row(1, 'pending_approval')];
    await w.vm.$nextTick();
    await w.find('button').trigger('click');
    expect(dcc.panelTab).toBe('dcc');
  });
});
