// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /avatars command (#607) — the slash-command surface over
// avatar tile sets (the Avatars section in Settings is a view over the same
// store). Pure like the other command parsers; the SFC's runAvatars resolves
// names against the store. Set names may contain spaces, so a name is the
// rest of the line, with one layer of surrounding quotes stripped.

export type AvatarsCommand =
  | { kind: 'list' }
  | { kind: 'use'; name: string }
  | { kind: 'delete'; name: string }
  | { kind: 'error'; message: string };

const USE = new Set(['use', 'apply', 'switch']);
const DELETE = new Set(['delete', 'del', 'remove', 'rm']);
const LIST = new Set(['list', 'ls']);

const USAGE = 'usage: /avatars [list] · /avatars use <set> · /avatars delete <set>';

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}

export function parseAvatarsCommand(argLine: string): AvatarsCommand {
  const trimmed = (argLine || '').trim();
  if (!trimmed) return { kind: 'list' };
  const space = trimmed.search(/\s/);
  const verb = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const name = space < 0 ? '' : stripQuotes(trimmed.slice(space + 1).trim());
  if (LIST.has(verb)) return { kind: 'list' };
  if (USE.has(verb) || DELETE.has(verb)) {
    if (!name) return { kind: 'error', message: `${verb} needs a set name — ${USAGE}` };
    return { kind: USE.has(verb) ? 'use' : 'delete', name };
  }
  return { kind: 'error', message: USAGE };
}
