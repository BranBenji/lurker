// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * The scope flag at the front of an /away or /back line (#994), as irssi and
 * WeeChat spell it: `-all` for every network, `-one` for just this one. `all` is
 * undefined without a flag, so the server's away.all_networks setting decides.
 * Only a leading flag counts: `/away back at -all hands` is a message.
 */
export function parseAwayFlag(argLine: string): { all: boolean | undefined; rest: string } {
  const m = /^-(all|one)(?:\s+|$)/i.exec(argLine.trimStart());
  if (!m) return { all: undefined, rest: argLine };
  return { all: m[1].toLowerCase() === 'all', rest: argLine.trimStart().slice(m[0].length) };
}
