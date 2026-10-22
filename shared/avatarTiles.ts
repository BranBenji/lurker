// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Generated avatar tiles (#607): which image of a set a nick gets. A tile is
// one image from the active set drawn over the nick's colour, so every nick
// has an avatar on every network, and a metadata avatar replaces it where one
// is set. Shared so the web client, the apps and the server pick the same
// image for the same nick.
//
// The nick is trimmed and lowercased the way the nick colour is (weechat's
// gui_nick_find_color: `bob_` and `bob` share one), then hashed with djb2 like
// the colour — but salted. The palette has 16 entries and a set may have 100,
// which share a factor, so the colour's own hash value modulo the count would
// leave three in four colour-and-tile pairs unreachable.

export const DEFAULT_AVATAR_SET = 'default';
export const DEFAULT_AVATAR_SET_URL = '/avatars/default';

/**
 * The sets that ship with the client. A `tiles` set is static files under
 * `url` with a manifest.json; an `initial` set has no files — the client draws
 * the first letter of the name in the box, in the given ink.
 */
export interface BuiltinAvatarSet {
  id: string;
  name: string;
  kind: 'tiles' | 'initial';
  url?: string;
  ink?: 'light' | 'dark';
}
export const BUILTIN_AVATAR_SETS: readonly BuiltinAvatarSet[] = [
  { id: DEFAULT_AVATAR_SET, name: 'Default', kind: 'tiles', url: DEFAULT_AVATAR_SET_URL },
  // One tile each, a bust silhouette — the generic avatar every chat app has
  // — in white or in near-black, for anyone who finds the art too much. Which
  // reads better depends on the nick palette, so both are offered and the
  // user picks.
  { id: 'plain-light', name: 'Plain (Light)', kind: 'tiles', url: '/avatars/plain-light' },
  { id: 'plain-dark', name: 'Plain (Dark)', kind: 'tiles', url: '/avatars/plain-dark' },
  // The first letter of the display name (or the nick), as many clients do.
  { id: 'initial-light', name: 'Initial (Light)', kind: 'initial', ink: 'light' },
  { id: 'initial-dark', name: 'Initial (Dark)', kind: 'initial', ink: 'dark' },
];
export function isBuiltinAvatarSetId(id: string): boolean {
  return BUILTIN_AVATAR_SETS.some((set) => set.id === id);
}
// The stop characters the nick colour uses by default (look.nick.color_stop_chars).
export const DEFAULT_STOP_CHARS = '_|';

export interface AvatarSetManifest {
  count: number;
  ext: string;
}

const TILE_SALT = 'avatar-tile:';

function trimForHash(nick: string, stopChars: string): string {
  let out = '';
  let seenOther = false;
  for (const ch of nick) {
    const isStop = stopChars.includes(ch);
    if (isStop && seenOther) break;
    if (!isStop) seenOther = true;
    out += ch;
  }
  return out;
}

function djb2(str: string): number {
  let h = 5381 >>> 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    const term = (((h << 5) >>> 0) + (h >>> 2) + cp) >>> 0;
    h = (h ^ term) >>> 0;
  }
  return h;
}

/** The index in a set of `count` tiles for a nick, or -1 for nothing to pick. */
export function tileIndex(
  nick: string | null | undefined,
  count: number,
  stopChars: string = DEFAULT_STOP_CHARS,
): number {
  if (!nick || !Number.isFinite(count) || count <= 0) return -1;
  const normalized = trimForHash(nick, stopChars || '').toLowerCase();
  if (!normalized) return -1;
  return djb2(TILE_SALT + normalized) % Math.floor(count);
}

/** `<base>/<nnn>.<ext>`: tiles are numbered from 000 in file-name order. */
export function tileUrl(baseUrl: string, index: number, ext: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${String(index).padStart(3, '0')}.${ext}`;
}
