// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `/metadata`, `/avatar` and `/displayname` (IRCv3 draft/metadata-2, #607):
// the lines they put on the wire. Pure, like the other command helpers. The
// server echoes the reply (a 761 per key, or a FAIL) where a /command's reply
// goes, so nothing here needs an answer.
//
//   /metadata set <key> <value>      METADATA * SET <key> :<value>
//   /metadata del <key>              METADATA * SET <key>        (no value unsets)
//   /metadata list [nick|#chan]      METADATA <target> LIST
//   /metadata clear                  METADATA * CLEAR
//   /avatar <url> | off              the avatar key
//   /displayname <name> | off        the display-name key
//
// A change to our own keys says what it writes too (#1189): the server saves
// it as it goes out, and on a disconnected network the client saves it by
// REST instead, to be set at the next connect.

import { METADATA_KEY_RE, type OwnMetadataWrite } from '../../../../shared/metadataKeys.js';
import type { NetworkState } from '../../stores/networks.js';

export type MetadataCommand = { line: string; write?: OwnMetadataWrite } | { error: string };

const USAGE =
  'usage: /metadata set <key> <value> · /metadata del <key> · /metadata list [nick|#chan] · /metadata clear';

function setLine(key: string, value: string | null): MetadataCommand {
  if (!METADATA_KEY_RE.test(key)) {
    return { error: `invalid metadata key: ${key} (a-z, 0-9, _ . / -)` };
  }
  const clean = value === null ? null : value.replace(/[\r\n\0]/g, '').trim();
  return {
    line: clean ? `METADATA * SET ${key} :${clean}` : `METADATA * SET ${key}`,
    write: { key, value: clean || null },
  };
}

/**
 * Why a connected network can't carry our own metadata, or null when it can
 * (or isn't connected, where it's saved for later). soju offers the cap with
 * max-keys=0 and refuses a SET on `*`.
 */
export function ownMetadataRefusal(state: NetworkState | undefined): string | null {
  if (state?.state !== 'connected') return null;
  if (!state.metadataLimits) return "this network doesn't support IRCv3 metadata";
  if (state.metadataLimits.maxKeys === 0) return "this network doesn't keep metadata for you";
  return null;
}

/** `/metadata <sub> …` → the wire line, or what to tell the user. */
export function parseMetadataCommand(argLine: string): MetadataCommand {
  const trimmed = argLine.trim();
  const space = trimmed.search(/\s/);
  const sub = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  switch (sub) {
    case 'set': {
      const at = rest.search(/\s/);
      if (!rest || at < 0) return { error: 'usage: /metadata set <key> <value>' };
      return setLine(rest.slice(0, at).toLowerCase(), rest.slice(at + 1));
    }
    case 'del':
    case 'unset':
    case 'delete': {
      if (!rest || /\s/.test(rest)) return { error: 'usage: /metadata del <key>' };
      return setLine(rest.toLowerCase(), null);
    }
    case 'list': {
      const target = rest.split(/\s+/)[0] || '*';
      return { line: `METADATA ${target} LIST` };
    }
    case 'clear':
      return { line: 'METADATA * CLEAR', write: 'clear' };
    default:
      return { error: USAGE };
  }
}

/** `/avatar <url>` or `/avatar off`. */
export function parseAvatarCommand(argLine: string): MetadataCommand {
  const value = argLine.trim();
  if (!value) return { error: 'usage: /avatar <https://…/image.png> · /avatar off' };
  if (value.toLowerCase() === 'off') return setLine('avatar', null);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: 'the avatar must be an http(s) URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'the avatar must be an http(s) URL' };
  }
  return setLine('avatar', value);
}

/** `/displayname <name>` or `/displayname off`. */
export function parseDisplayNameCommand(argLine: string): MetadataCommand {
  const value = argLine.trim();
  if (!value) return { error: 'usage: /displayname <name> · /displayname off' };
  if (value.toLowerCase() === 'off') return setLine('display-name', null);
  return setLine('display-name', value);
}
