// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The XDCC queue's vocabulary (#1085), shared by the server that runs the
// queue and the client that shows it, so the two can't drift.

/** The most packs one request may queue: a guard against a typo like
 *  `/xdcc addl bot 1 100000`, not a quota. */
export const XDCC_MAX_PACKS = 500;

/** The trigger a queued pack sends: what iroffer and every bot like it take.
 *  `#` is the XDCC pack sigil here, not a channel. */
export function xdccTrigger(pack: number): string {
  return `XDCC SEND #${pack}`;
}

/** A queued pack's name until the bot's offer brings the real one. */
export function xdccPlaceholderName(pack: number): string {
  return `XDCC #${pack}`;
}

/** Whether a transfer's name is still a queued pack's placeholder. */
export function isXdccPlaceholder(name: string, pack: number | null | undefined): boolean {
  return pack != null && name === xdccPlaceholderName(pack);
}

/** Pack numbers for a line: `#31`, `#29–#32` for a run of three or more,
 *  else `#29, #31 and #35`. In the order given. */
export function describePacks(packs: readonly number[]): string {
  const run = packs.length >= 3 && packs.every((p, i) => i === 0 || p === packs[i - 1] + 1);
  if (run) return `#${packs[0]}–#${packs[packs.length - 1]}`;
  const names = packs.map((p) => `#${p}`);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A bot's answer that refuses the request rather than taking it (iroffer
 *  and its kin): the request fails on it instead of waiting. A pack that
 *  doesn't exist, a request denied, a queue with no room. */
export function isXdccRefusal(text: string): boolean {
  return /invalid pack|no such pack|denied|not allowed|must be (?:on|in) |queue (?:of size \d+ )?is full|closing connection/i.test(
    text,
  );
}
