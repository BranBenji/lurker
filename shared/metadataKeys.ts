// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 metadata keys (#607, #1189): what a key may be named and how long a
// value Lurker keeps may be. The server's vetting (ircMetadata.ts) and the
// profile editor read the same numbers.

export const METADATA_KEY_RE = /^[a-z0-9_./-]+$/;

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
