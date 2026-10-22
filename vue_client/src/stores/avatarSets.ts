// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Avatar tile sets (#607): the bundled sets (shared/avatarTiles.ts, the tile
// ones under public/avatars/) and the sets the user uploaded
// (/api/avatar-sets), plus the pointer that picks one (look.avatars.set,
// 'initial-dark' out of the box). Answers "which image goes
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
  BUILTIN_AVATAR_SETS,
  DEFAULT_AVATAR_SET,
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
  // An Initial set draws a letter in this ink instead of a tile.
  initialInk?: 'light' | 'dark';
}

export const useAvatarSetsStore = defineStore('avatarSets', {
  state: () => ({
    // Each bundled set's manifest, once fetched; absent until then (no tile).
    builtinManifests: {} as Record<string, AvatarSetManifest>,
    builtinLoad: null as Promise<void> | null,
    // The user's uploaded sets, as the server lists them.
    saved: [] as AvatarSetSummary[],
    loaded: false,
  }),
  getters: {
    /** The bundled sets first, then the uploaded ones (server keeps them name-sorted). */
    all(state): AvatarSetEntry[] {
      const bundled: AvatarSetEntry[] = BUILTIN_AVATAR_SETS.map((set) =>
        set.kind === 'initial'
          ? {
              id: set.id,
              name: set.name,
              count: 1,
              builtin: true,
              baseUrl: '',
              ext: '',
              initialInk: set.ink,
            }
          : {
              id: set.id,
              name: set.name,
              count: state.builtinManifests[set.id]?.count ?? 0,
              builtin: true,
              baseUrl: set.url ?? '',
              ext: state.builtinManifests[set.id]?.ext ?? AVATAR_TILE_EXT,
            },
      );
      return [
        ...bundled,
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
    /** The pointer, resolved; one at a set we don't have falls back to the registry default. */
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
        if (!set || set.count <= 0 || set.initialInk) return null;
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
    // Fetch every bundled set's manifest once. Safe to call from every tile:
    // one request each, and a failure leaves those squares plain rather than
    // retrying on every render. Revalidated every time: a rebuilt set changes
    // the count, and a copy the browser kept would point tiles at files that
    // are gone.
    ensureBuiltins(): Promise<void> {
      if (this.builtinLoad) return this.builtinLoad;
      if (typeof fetch !== 'function') return Promise.resolve();
      const missing = BUILTIN_AVATAR_SETS.filter(
        (set) => set.kind === 'tiles' && !this.builtinManifests[set.id],
      );
      if (missing.length === 0) return Promise.resolve();
      this.builtinLoad = (async () => {
        await Promise.all(
          missing.map(async (set) => {
            try {
              const res = await fetch(`${set.url}/manifest.json`, { cache: 'no-cache' });
              if (!res.ok) return;
              const body = (await res.json()) as Partial<AvatarSetManifest>;
              const count = Number(body.count);
              if (!Number.isInteger(count) || count <= 0) return;
              this.builtinManifests[set.id] = {
                count,
                ext: typeof body.ext === 'string' ? body.ext : AVATAR_TILE_EXT,
              };
            } catch {
              /* no fetch here (tests), or the set is missing: plain squares */
            }
          }),
        );
      })();
      return this.builtinLoad;
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
