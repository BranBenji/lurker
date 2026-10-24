// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 metadata keys (#607, #1189): what a key may be named and how long a
// value Lurker keeps may be. The server's vetting (ircMetadata.ts) and the
// profile editor read the same numbers.

export const METADATA_KEY_RE = /^[a-z0-9_./-]+$/;

// The keys Lurker shows, in order of preference: a server with a small
// `max-subs` grants the first. `color` is deliberately absent (#607): hex
// values fight every theme. The profile editor's fields too (#1189).
export const METADATA_SUB_KEYS = ['display-name', 'avatar', 'pronouns', 'homepage', 'status'];

// Values longer than this are dropped rather than truncated: a truncated URL
// is a different URL, and a truncated name reads as someone else's.
export const METADATA_VALUE_MAX_CHARS: Readonly<Record<string, number>> = {
  'display-name': 64,
  pronouns: 64,
  status: 200,
  homepage: 2048,
  avatar: 2048,
};

// A key Lurker doesn't show, bounded like a status.
export const METADATA_EXTRA_VALUE_MAX_CHARS = 512;

// A change to our own metadata: one key (null unsets it), or all of them.
export type OwnMetadataWrite = { key: string; value: string | null } | 'clear';

/**
 * Why our own metadata can't be set on a network now, or null when it can:
 * connected, with the cap and room for a key (soju offers the cap with
 * max-keys=0 and refuses a SET on `*`). The server and the client say the same.
 */
export function ownMetadataRefusal(
  connected: boolean,
  limits: { maxKeys: number | null } | null | undefined,
): string | null {
  if (!connected) return 'not connected';
  if (!limits) return "this network doesn't support IRCv3 metadata";
  if (limits.maxKeys === 0) return "this network doesn't keep metadata for you";
  return null;
}
