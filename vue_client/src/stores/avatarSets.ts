// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Avatar tile sets (#607): the bundled set in public/avatars/default and the
// sets the user uploaded (/api/avatar-sets), plus the pointer that picks one
// (look.avatars.set, 'default' for the bundled set). Answers "which image goes
// on this nick's tile" — the nick colour behind it is the nick colour's
// business, and a metadata avatar replaces the whole tile where one is set
// (NickAvatar.vue).
//
// Uploaded sets refetch on the 'avatar-sets-changed' socket frame and on every
// (re)connect, the themes contract; the bundled set's manifest is fetched once.

import { defineStore } from 'pinia';
import { api, apiMultipart } from '../api.js';
import { useSettingsStore } from './settings.js';
import {
  DEFAULT_AVATAR_SET,
  DEFAULT_AVATAR_SET_URL,
  DEFAULT_STOP_CHARS,
  tileIndex,
  tileUrl,
  type AvatarSetManifest,
} from '../../../shared/avatarTiles.js';
import { AVATAR_TILE_EXT, type AvatarSetSummary } from '../../../shared/avatarSets.js';

export const AVATAR_SET_POINTER_KEY = 'look.avatars.set';

/** One set as the UI and the tile picker see it: bundled or uploaded. */
export interface AvatarSetEntry {
  id: string;
  name: string;
  count: number;
  builtin: boolean;
  baseUrl: string;
  ext: string;
}

export const useAvatarSetsStore = defineStore('avatarSets', {
  state: () => ({
    // The bundled set's manifest, once fetched; null until then (no tile).
    defaultManifest: null as AvatarSetManifest | null,
    defaultLoad: null as Promise<void> | null,
    // The user's uploaded sets, as the server lists them.
    saved: [] as AvatarSetSummary[],
    loaded: false,
  }),
  getters: {
    /** The bundled set first, then the uploaded ones (server keeps them name-sorted). */
    all(state): AvatarSetEntry[] {
      const bundled: AvatarSetEntry = {
        id: DEFAULT_AVATAR_SET,
        name: 'Default',
        count: state.defaultManifest?.count ?? 0,
        builtin: true,
        baseUrl: DEFAULT_AVATAR_SET_URL,
        ext: state.defaultManifest?.ext ?? AVATAR_TILE_EXT,
      };
      return [
        bundled,
        ...state.saved.map((s) => ({
          id: String(s.id),
          name: s.name,
          count: s.count,
          builtin: false,
          baseUrl: `/api/avatar-sets/${s.id}`,
          ext: AVATAR_TILE_EXT,
        })),
      ];
    },
    byId(): (id: string) => AvatarSetEntry | null {
      return (id: string) => this.all.find((s) => s.id === id) || null;
    },
    /** The pointer, resolved; one at a set we don't have falls back to the bundled set. */
    activeSetId(): string {
      const settings = useSettingsStore();
      const id = String(settings.effective(AVATAR_SET_POINTER_KEY) ?? DEFAULT_AVATAR_SET);
      return this.byId(id) ? id : DEFAULT_AVATAR_SET;
    },
    activeSet(): AvatarSetEntry {
      return this.byId(this.activeSetId) || this.all[0];
    },
    // The tile image for a nick, or null while the set has no tiles to pick
    // from (the coloured square still shows).
    tileFor(): (nick: string) => string | null {
      return (nick: string) => {
        const set = this.activeSet;
        if (!set || set.count <= 0) return null;
        const settings = useSettingsStore();
        const stopChars = String(
          settings.effective('look.nick.color_stop_chars') ?? DEFAULT_STOP_CHARS,
        );
        const index = tileIndex(nick, set.count, stopChars);
        return index < 0 ? null : tileUrl(set.baseUrl, index, set.ext);
      };
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
          this.defaultManifest = {
            count,
            ext: typeof body.ext === 'string' ? body.ext : AVATAR_TILE_EXT,
          };
        } catch {
          /* no fetch here (tests), or the set is missing: plain squares */
        }
      })();
      return this.defaultLoad;
    },
    hydrate(items: AvatarSetSummary[]) {
      this.saved = items;
      this.loaded = true;
    },
    async fetchAll() {
      const { items } = await api('/api/avatar-sets');
      this.hydrate(items);
    },
    /** Upload a zip as a new set; resolves to the set and what was skipped. */
    async upload(
      name: string,
      zip: File | Blob,
      onProgress?: (percent: number) => void,
    ): Promise<{ set: AvatarSetSummary; skipped: Array<{ name: string; reason: string }> }> {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('zip', zip, 'set.zip');
      const result = await apiMultipart('/api/avatar-sets', fd, { onProgress });
      await this.fetchAll();
      return result;
    },
    async remove(id: number) {
      await api(`/api/avatar-sets/${id}`, { method: 'DELETE' });
      // The server resets a pointer that dangled; its settings broadcast and
      // the avatar-sets-changed frame follow. Refresh the list now for this tab.
      await this.fetchAll();
    },
    /** Point generated avatars at a set. */
    async use(id: string) {
      await useSettingsStore().setValue(AVATAR_SET_POINTER_KEY, id);
    },
  },
});
