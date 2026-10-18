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

/** One fact on a meta line, as an object: the text, a muted prefix drawn before it
 *  (the "libera/" of "libera/Bot", as the status bar draws it), a tone, a class. */
export interface MetaPartObject {
  text: string;
  prefix?: string;
  tone?: 'good' | 'bad' | null;
  class?: string;
}

/** One fact on a meta line. A falsy part isn't there. */
export type MetaPart = string | number | false | null | undefined | MetaPartObject;

/** The parts that are there, each as an object. */
export function metaParts(parts: MetaPart[]): MetaPartObject[] {
  const out: MetaPartObject[] = [];
  for (const p of parts) {
    if (!p) continue;
    out.push(typeof p === 'object' ? p : { text: String(p) });
  }
  return out;
}

/**
 * Join the parts of a meta line as plain text, for a notification title or a
 * line typed into the buffer. In a template, `<MetaLine>` renders the same parts
 * with the separators dimmed.
 */
export function joinMeta(parts: MetaPart[]): string {
  return metaParts(parts)
    .map((p) => (p.prefix ?? '') + p.text)
    .join(` ${META_SEPARATOR} `);
}
