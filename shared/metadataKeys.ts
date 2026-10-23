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

/** What a change saved while the network isn't connected says, server or client. */
export function savedForLaterText(write: OwnMetadataWrite): string {
  if (write === 'clear') return 'Metadata cleared; it is cleared at the next connect.';
  return write.value === null
    ? `${write.key} unset; it is unset at the next connect.`
    : `${write.key} saved; it is set at the next connect, if this network supports metadata.`;
}
