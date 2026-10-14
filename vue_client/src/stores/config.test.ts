// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({ api: vi.fn<(url: string) => Promise<unknown>>() }));
vi.mock('../api.js', () => ({ api: h.api }));

import { useConfigStore } from './config.js';

describe('config store features', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.api.mockReset();
  });

  // Settings hides a category whose flag is missing, so a flag the store
  // forgets to copy hides its pane on every instance.
  it('keeps every flag the server advertises', async () => {
    h.api.mockResolvedValue({
      edition: 'standalone',
      features: { linkPreviews: true, bouncer: true, dcc: true },
    });
    const config = useConfigStore();
    await config.fetch();
    expect(config.features).toEqual({ linkPreviews: true, bouncer: true, dcc: true });
  });

  it('reads a flag the server leaves out as off', async () => {
    h.api.mockResolvedValue({ edition: 'standalone', features: {} });
    const config = useConfigStore();
    await config.fetch();
    expect(config.features).toEqual({ linkPreviews: false, bouncer: false, dcc: false });
  });
});
