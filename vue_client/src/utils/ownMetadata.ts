// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Our own IRCv3 metadata as Lurker saved it per network (#1189): the profile
// editor's source.

import { api } from '../api.js';

export interface OwnMetadata {
  // What Lurker saved and re-sets after each connect.
  values: Record<string, string>;
  // Saved unsets: keys Lurker clears on the server after each connect.
  unset: string[];
  // What the server has now, as far as Lurker could save it; null when the
  // network isn't connected or can't carry it.
  live: Record<string, string> | null;
  // The saved avatar as other people's clients fetch it (the media proxy), or
  // null with previews off.
  avatarPreview: string | null;
}

const base = (networkId: number) => `/api/networks/${networkId}/metadata`;

export function fetchOwnMetadata(networkId: number): Promise<OwnMetadata> {
  return api<OwnMetadata>(base(networkId));
}

/** Save the keys named (null unsets one); the rest stay as saved. */
export function saveOwnMetadata(
  networkId: number,
  values: Record<string, string | null>,
): Promise<OwnMetadata> {
  return api<OwnMetadata>(base(networkId), { method: 'PUT', body: { values } });
}

export function clearOwnMetadata(networkId: number): Promise<OwnMetadata> {
  return api<OwnMetadata>(base(networkId), { method: 'DELETE' });
}
