// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The flock as the `sheep.flock` setting stores it: one "<id>:<color>" entry
// per sheep, in spawn order. The id is what a client keys its running pet on;
// the color is the sheep's own, and its name comes with the color from the
// pet file (Rick is the red sheep, as in the original). Pure, shared by the
// store, the overlay and the command.

import { isSheepColor, type SheepColor } from './colors.js';

export interface FlockEntry {
  id: string;
  color: SheepColor;
}

const ID_RE = /^[a-z0-9]{4,16}$/;

/** Reads the setting value, dropping anything malformed or duplicated. */
export function parseFlock(raw: unknown): FlockEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FlockEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    // Entries once carried a third field (a name); it is ignored.
    const [id, color] = item.split(':');
    if (!ID_RE.test(id) || !isSheepColor(color) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, color });
  }
  return out;
}

export function formatFlock(entries: readonly FlockEntry[]): string[] {
  return entries.map((e) => `${e.id}:${e.color}`);
}

/** How a sheep is referred to: by its pet name, or as "the blue sheep" when the pet file has none. */
export function describeSheep(e: { color: SheepColor; name?: string }): string {
  return e.name || `the ${e.color} sheep`;
}

/** A fresh sheep id: short, lowercase, unique enough for a flock. */
export function newFlockId(rng: () => number = Math.random): string {
  let s = '';
  while (s.length < 6) s += Math.floor(rng() * 36).toString(36);
  return s;
}
