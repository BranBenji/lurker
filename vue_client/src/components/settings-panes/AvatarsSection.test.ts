// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Settings → Appearance → Avatars: a picture someone set through IRCv3 metadata
// is fetched only through the previews decoder, so the section promises one
// only where this server has previews on.

import { describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../../api.js', () => ({
  api: vi.fn<() => Promise<unknown>>(async () => ({ items: [] })),
  apiMultipart: vi.fn<() => Promise<unknown>>(),
}));
// The bundled sets' manifests: none, so the preview tiles stay plain squares.
vi.stubGlobal(
  'fetch',
  vi.fn<() => Promise<Response>>(async () => new Response(null, { status: 404 })),
);

import AvatarsSection from './AvatarsSection.vue';
import { useConfigStore } from '../../stores/config.js';

async function description(linkPreviews: boolean): Promise<string> {
  setActivePinia(createPinia());
  useConfigStore().features = { linkPreviews, bouncer: false, dcc: false };
  const wrapper = mount(AvatarsSection, { global: { stubs: { NickAvatar: true } } });
  await flushPromises();
  return wrapper.get('.section-desc').text();
}

describe('AvatarsSection', () => {
  it('mentions pictures people set only when this server has previews', async () => {
    expect(await description(true)).toContain('the picture someone set through IRCv3 metadata');
    const without = await description(false);
    expect(without).not.toContain('IRCv3 metadata');
    expect(without).toContain('a tile from the active set.');
  });
});
