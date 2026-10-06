// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_PREFIX, rankIndex, type PrefixMode } from '../../../shared/channelModes.js';

// A member's channel-mode glyph, rank, and glyph colour, read from the
// network's own PREFIX (`modeSpec.prefix`, highest rank first). Shared by the
// member list, the self-identity prompt, and the message list so the glyph
// stays consistent everywhere it appears (#1032).
//
// `prefix` is null while the network hasn't sent its ISUPPORT yet; that falls
// back to the conventional q/a/o/h/v → ~/&/@/%/+ table. Display only — rank
// gates go through hasRankAtLeast.
type Prefix = readonly PrefixMode[] | null | undefined;

const orDefault = (prefix: Prefix): readonly PrefixMode[] => prefix ?? DEFAULT_PREFIX;

// The symbol of the highest-ranked prefix mode the member holds, or '' when
// they hold none.
export function prefixOf(modes: readonly string[] | null | undefined, prefix: Prefix): string {
  const list = orDefault(prefix);
  const i = rankIndex(modes, list);
  return i === -1 ? '' : list[i].symbol;
}

// Sort key for the member list: 0 for the top rank, and members with no prefix
// mode after every rank the network has.
export function prefixRank(modes: readonly string[] | null | undefined, prefix: Prefix): number {
  const list = orDefault(prefix);
  const i = rankIndex(modes, list);
  return i === -1 ? list.length : i;
}

// The five colour tiers (the --member-* tokens), keyed by the letter's
// conventional role. Keyed by letter, not by position: on Libera's (ov)@+ the
// top rank is op, and colouring by position would paint it as owner.
const TIERS: Record<string, string> = {
  q: 'owner',
  a: 'admin',
  o: 'op',
  h: 'halfop',
  v: 'voice',
};

// CSS class for the glyph colour (e.g. `mode-op`), or '' when there's no
// prefix. A letter outside q/a/o/h/v takes the tier of the nearest known letter
// that outranks it, or the owner tier when nothing does: a `Y` above `q` is
// coloured as an owner, an `X` between `o` and `h` as an op.
export function prefixClass(modes: readonly string[] | null | undefined, prefix: Prefix): string {
  const list = orDefault(prefix);
  const i = rankIndex(modes, list);
  if (i === -1) return '';
  for (let j = i; j >= 0; j--) {
    const tier = TIERS[list[j].mode];
    if (tier) return `mode-${tier}`;
  }
  return 'mode-owner';
}
