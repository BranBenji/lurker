// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Admin → DCC (#1080, #1125). The table is read-only; "edit" opens one editor
// under the row with chat, receive and the storage limit, and one save. A field
// that saved silently on blur left admins pressing Enter to make sure, so
// nothing saves until asked, and "saved" says it landed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
}));
vi.mock('../../api.js', () => ({ api: h.api }));

import DccPane from './DccPane.vue';

const GB = 1024 ** 3;

function info(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    directory: '/srv/dcc',
    maxFileBytes: 0,
    allowPrivateHosts: false,
    freeDiskFloorBytes: GB,
    users: [
      {
        id: 3,
        username: 'alice',
        chat: true,
        receive: false,
        limitBytes: 50 * GB,
        usedBytes: 0,
        ...over,
      },
    ],
  };
}

async function mountPane(over: Record<string, unknown> = {}, enabled = true): Promise<VueWrapper> {
  h.api.mockResolvedValueOnce({ ...info(over), enabled });
  const wrapper = mount(DccPane);
  await flushPromises();
  return wrapper;
}

const editButton = (w: VueWrapper) => w.findAll('button').find((b) => b.text() === 'edit')!;
const row = (w: VueWrapper) => w.find('table.users tbody tr').text();

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
});

describe('Admin → DCC', () => {
  it('shows each user as read-only text, with no inputs until edit', async () => {
    const w = await mountPane();
    expect(row(w)).toContain('alice');
    expect(row(w)).toContain('50.00 GB');
    expect(w.find('table.users input').exists()).toBe(false);
  });

  it('saves chat, receive and the limit together, and says so', async () => {
    const w = await mountPane();
    await editButton(w).trigger('click');
    const boxes = w.findAll('tr.editor input[type="checkbox"]');
    await boxes[1].setValue(true); // receive
    await w.find('tr.editor input.limit').setValue('25');
    h.api.mockResolvedValueOnce({ chat: true, receive: true, limitBytes: 25 * GB });
    await w.find('tr.editor form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenLastCalledWith('/api/admin/dcc/users/3', {
      method: 'PUT',
      body: { chat: true, receive: true, limitBytes: 25 * GB },
    });
    expect(w.find('tr.editor').exists()).toBe(false);
    expect(row(w)).toContain('25.00 GB');
    expect(row(w)).toContain('saved');
  });

  it('clears the limit when the field is emptied', async () => {
    const w = await mountPane();
    await editButton(w).trigger('click');
    await w.find('tr.editor input.limit').setValue('');
    h.api.mockResolvedValueOnce({ chat: true, receive: false, limitBytes: null });
    await w.find('tr.editor form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenLastCalledWith('/api/admin/dcc/users/3', {
      method: 'PUT',
      body: { chat: true, receive: false, limitBytes: null },
    });
    expect(row(w)).toContain('none');
  });

  it('changes nothing on cancel', async () => {
    const w = await mountPane();
    await editButton(w).trigger('click');
    await w.find('tr.editor input.limit').setValue('99');
    await w
      .findAll('tr.editor button')
      .find((b) => b.text() === 'cancel')!
      .trigger('click');
    expect(w.find('tr.editor').exists()).toBe(false);
    expect(h.api).toHaveBeenCalledTimes(1); // just the load
    expect(row(w)).toContain('50.00 GB');
  });

  it('keeps the editor open with what was typed when the save fails', async () => {
    const w = await mountPane();
    await editButton(w).trigger('click');
    await w.find('tr.editor input.limit').setValue('25');
    h.api.mockRejectedValueOnce(new Error('network down'));
    await w.find('tr.editor form').trigger('submit');
    await flushPromises();
    expect(w.find('tr.editor').text()).toContain('network down');
    expect((w.find('tr.editor input.limit').element as HTMLInputElement).value).toBe('25');
    expect(row(w)).not.toContain('saved');
  });

  it('refuses a limit that is not a positive number, without a request', async () => {
    const w = await mountPane();
    await editButton(w).trigger('click');
    await w.find('tr.editor input.limit').setValue('-3');
    await w.find('tr.editor form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(w.find('tr.editor').text()).toContain('above 0');
  });

  // A small limit read back as 0 looked like none, or like an invalid one.
  it('shows a small saved limit with the precision it has', async () => {
    const w = await mountPane({ limitBytes: Math.round(0.001 * GB) });
    await editButton(w).trigger('click');
    expect((w.find('tr.editor input.limit').element as HTMLInputElement).value).toBe('0.001');
  });

  // With DCC off for the instance a grant can be cleared before it comes back
  // on, but not given.
  it('lets a part be taken away, not given, while DCC is off', async () => {
    const w = await mountPane({}, false);
    await editButton(w).trigger('click');
    const [chat, receive] = w.findAll('tr.editor input[type="checkbox"]');
    expect((chat.element as HTMLInputElement).disabled).toBe(false);
    expect((receive.element as HTMLInputElement).disabled).toBe(true);
  });
});
