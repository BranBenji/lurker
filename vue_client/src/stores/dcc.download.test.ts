// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));

import { useDccStore } from './dcc.js';

function refusal(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe('dcc store download', () => {
  let clicked: string[];

  beforeEach(() => {
    setActivePinia(createPinia());
    h.api.mockReset();
    clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.getAttribute('href') ?? '');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks with a HEAD, then hands the file to the browser', async () => {
    h.api.mockResolvedValue(null);
    await useDccStore().download(7);
    expect(h.api).toHaveBeenCalledWith('/api/dcc/7/file', { method: 'HEAD' });
    expect(clicked).toEqual(['/api/dcc/7/file']);
  });

  // Handed to the browser, the refusal would be saved as a .json file.
  it('shows a removed file on the row and never starts the download', async () => {
    h.api.mockRejectedValue(refusal(410, 'Gone'));
    const dcc = useDccStore();
    await expect(dcc.download(7)).rejects.toThrow('file is no longer on the server');
    expect(dcc.actionError[7]).toBe('file is no longer on the server');
    expect(dcc.busy[7]).toBeUndefined();
    expect(clicked).toEqual([]);
  });

  it('falls back to the request error for a status it has no words for', async () => {
    h.api.mockRejectedValue(refusal(500, 'internal error'));
    const dcc = useDccStore();
    await expect(dcc.download(7)).rejects.toThrow('internal error');
    expect(dcc.actionError[7]).toBe('internal error');
  });
});
