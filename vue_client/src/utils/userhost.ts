// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `nick!user@host` → its user and host, tolerating missing pieces. What the
// Ignore action hands IgnoreModal to build a mask from.
export function parseUserHost(userhost: string | null | undefined): {
  user: string | null;
  host: string | null;
} {
  if (!userhost) return { user: null, host: null };
  const bang = userhost.indexOf('!');
  if (bang < 0) return { user: null, host: null };
  const rest = userhost.slice(bang + 1);
  const at = rest.indexOf('@');
  if (at < 0) return { user: null, host: null };
  return { user: rest.slice(0, at) || null, host: rest.slice(at + 1) || null };
}
