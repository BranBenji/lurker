// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * The separator between the facts on a secondary line — a notification's
 * "libera | #general", a highlight rule's "QUACK! | whole word | #chan", an upload's
 * "2h ago | 412 KB".
 *
 * A pipe with a space each side, after a middot (·) that all but vanished in the muted
 * grey these lines are rendered in, and then a bullet (•). A nick can carry a pipe too
 * ("brad|afk"), so the spaces around the separator are what tell it apart; never join
 * without them.
 *
 * ⚠ Not used for the `/help` command examples in MessageInput. Those are monospace,
 * terminal-shaped text where a middot between example commands reads correctly.
 */
export const META_SEPARATOR = '|';

/**
 * Join the parts of a meta line, dropping the ones that aren't there.
 *
 * Built in JS rather than as adjacent template spans because Vue's whitespace
 * condensing strips the gaps between those, and the separator needs its spaces.
 */
export function joinMeta(parts: Array<string | number | false | null | undefined>): string {
  return parts.filter(Boolean).join(` ${META_SEPARATOR} `);
}
