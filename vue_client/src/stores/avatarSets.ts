// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Avatar tile sets (#607): the bundled set in public/avatars/default and, when
// the user points look.avatars.set at one, a set they uploaded. Answers "which
// image goes on this nick's tile" — the nick colour behind it is the nick
// colour's business, and a metadata avatar replaces the whole tile where one
// is set (NickAvatar.vue).

import { defineStore } from 'pinia';
import { useSettingsStore } from './settings.js';
import {
  DEFAULT_AVATAR_SET,
  DEFAULT_AVATAR_SET_URL,
  DEFAULT_STOP_CHARS,
  tileIndex,
  tileUrl,
  type AvatarSetManifest,
} from '../../../shared/avatarTiles.js';

export const useAvatarSetsStore = defineStore('avatarSets', {
  state: () => ({
    // The bundled set's manifest, once fetched; null until then (no tile).
    defaultManifest: null as AvatarSetManifest | null,
    defaultLoad: null as Promise<void> | null,
  }),
  getters: {
    // The tile image for a nick, or null while the set hasn't loaded (the
    // coloured square still shows).
    tileFor:
      (state) =>
      (nick: string): string | null => {
        const settings = useSettingsStore();
        const setId = String(settings.effective('look.avatars.set') || DEFAULT_AVATAR_SET);
        const stopChars = String(
          settings.effective('look.nick.color_stop_chars') ?? DEFAULT_STOP_CHARS,
        );
        if (setId !== DEFAULT_AVATAR_SET) {
          // An uploaded set: resolved once the sets list is in (next layer);
          // until then, the bundled one.
        }
        const manifest = state.defaultManifest;
        if (!manifest) return null;
        const index = tileIndex(nick, manifest.count, stopChars);
        if (index < 0) return null;
        return tileUrl(DEFAULT_AVATAR_SET_URL, index, manifest.ext);
      },
  },
  actions: {
    // Fetch the bundled set's manifest once. Safe to call from every tile:
    // one request, and a failure leaves the squares plain rather than
    // retrying on every render.
    ensureDefault(): Promise<void> {
      if (this.defaultLoad) return this.defaultLoad;
      // Already known (a test seeds it), or nowhere to fetch from.
      if (this.defaultManifest || typeof fetch !== 'function') return Promise.resolve();
      this.defaultLoad = (async () => {
        try {
          const res = await fetch(`${DEFAULT_AVATAR_SET_URL}/manifest.json`, {
            cache: 'force-cache',
          });
          if (!res.ok) return;
          const body = (await res.json()) as Partial<AvatarSetManifest>;
          const count = Number(body.count);
          if (!Number.isInteger(count) || count <= 0) return;
          this.defaultManifest = { count, ext: typeof body.ext === 'string' ? body.ext : 'webp' };
        } catch {
          /* no fetch here (tests), or the set is missing: plain squares */
        }
      })();
      return this.defaultLoad;
    },
  },
});
