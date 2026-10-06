// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_PREFIX, rankIndex, type PrefixMode } from '../../../shared/channelModes.js';
import { isChannelTarget } from '../../../shared/channels.js';

// A member's channel-mode glyph, rank, and glyph colour, read from the
// network's own PREFIX (`modeSpec.prefix`, highest rank first). Shared by the
// member list, the self-identity prompt, the message list, and the whois
// channel list so the glyph stays consistent everywhere it appears (#1032).
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

// The five colour tiers (the --member-* tokens). A rank's tier comes from its
// letter's conventional role, then from its symbol's. Not from its position:
// on Libera's (ov)@+ the top rank is op, and colouring by position would paint
// it as owner.
const TIER_BY_LETTER: Record<string, string> = {
  q: 'owner',
  a: 'admin',
  o: 'op',
  h: 'halfop',
  v: 'voice',
};
const TIER_BY_SYMBOL: Record<string, string> = {
  '~': 'owner',
  '&': 'admin',
  '@': 'op',
  '%': 'halfop',
  '+': 'voice',
};

// CSS class for the glyph colour (e.g. `mode-op`), or '' when there's no
// prefix. A rank neither its letter nor its symbol places takes the tier of
// the nearest rank above it that has one, or owner when none does: on
// (Yqaohv)!~&@%+ a `Y` is coloured as an owner.
export function prefixClass(modes: readonly string[] | null | undefined, prefix: Prefix): string {
  const list = orDefault(prefix);
  const i = rankIndex(modes, list);
  if (i === -1) return '';
  for (let j = i; j >= 0; j--) {
    const tier = TIER_BY_LETTER[list[j].mode] ?? TIER_BY_SYMBOL[list[j].symbol];
    if (tier) return `mode-${tier}`;
  }
  return 'mode-owner';
}

// Split a WHOIS channel token (`@#chan`, `@+#chan`) into its rank symbols and
// the channel name. A symbol is peeled only while what's left still names a
// channel, because `&`, `+` and `!` are channel types too: `&ops` is a channel,
// not an admin on "ops", and `!#chan` is `#chan` under a `!` rank.
export function splitChannelToken(token: string, prefix: Prefix): { prefix: string; name: string } {
  const symbols = new Set(orDefault(prefix).map((p) => p.symbol));
  let i = 0;
  while (i < token.length && symbols.has(token[i]) && isChannelTarget(token.slice(i + 1))) i++;
  return { prefix: token.slice(0, i), name: token.slice(i) };
}
