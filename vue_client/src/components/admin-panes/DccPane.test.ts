// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The storage limit (#1125) saves only when asked: "save" (or Enter) shows once
// the value differs from what's stored, and "saved" confirms it landed. A field
// that saved silently on blur left admins pressing Enter to make sure.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
}));
vi.mock('../../api.js', () => ({ api: h.api }));

import DccPane from './DccPane.vue';

const GB = 1024 ** 3;

function info(limitBytes: number | null) {
  return {
    enabled: true,
    directory: '/srv/dcc',
    maxFileBytes: 0,
    allowPrivateHosts: false,
    freeDiskFloorBytes: GB,
    users: [{ id: 3, username: 'alice', chat: true, receive: true, limitBytes, usedBytes: 0 }],
  };
}

async function mountPane(limitBytes: number | null): Promise<VueWrapper> {
  h.api.mockResolvedValueOnce(info(limitBytes));
  const wrapper = mount(DccPane);
  await flushPromises();
  return wrapper;
}

const field = (w: VueWrapper) => w.find('input.limit');
const limitCell = (w: VueWrapper) => w.find('form.limit-form').text();

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
});

describe('Admin → DCC storage limit', () => {
  it('shows save only once the value changes, and nothing saves on its own', async () => {
    const w = await mountPane(50 * GB);
    expect(limitCell(w)).not.toContain('save');
    await field(w).setValue('60');
    await field(w).trigger('change');
    await field(w).trigger('blur');
    expect(limitCell(w)).toContain('save');
    expect(h.api).toHaveBeenCalledTimes(1); // just the load
    // Typing the stored value back hides it again.
    await field(w).setValue('50');
    expect(limitCell(w)).not.toContain('save');
  });

  it('saves on Enter and says so', async () => {
    const w = await mountPane(null);
    await field(w).setValue('25');
    h.api.mockResolvedValueOnce({ chat: true, receive: true, limitBytes: 25 * GB });
    await w.find('form.limit-form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenLastCalledWith('/api/admin/dcc/users/3', {
      method: 'PUT',
      body: { limitBytes: 25 * GB },
    });
    expect(limitCell(w)).toContain('saved');
    expect((field(w).element as HTMLInputElement).value).toBe('25');
  });

  it('clears the limit when the field is emptied', async () => {
    const w = await mountPane(50 * GB);
    await field(w).setValue('');
    h.api.mockResolvedValueOnce({ chat: true, receive: true, limitBytes: null });
    await w.find('form.limit-form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenLastCalledWith('/api/admin/dcc/users/3', {
      method: 'PUT',
      body: { limitBytes: null },
    });
  });

  it('keeps the draft and the save link when the save fails', async () => {
    const w = await mountPane(null);
    await field(w).setValue('25');
    h.api.mockRejectedValueOnce(new Error('network down'));
    await w.find('form.limit-form').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('network down');
    expect(limitCell(w)).toContain('save');
    expect(limitCell(w)).not.toContain('saved');
    expect((field(w).element as HTMLInputElement).value).toBe('25');
  });

  it('refuses a value that is not a positive number, without a request', async () => {
    const w = await mountPane(null);
    await field(w).setValue('-3');
    await w.find('form.limit-form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(w.text()).toContain('above 0');
  });
});
