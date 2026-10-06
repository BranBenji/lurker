// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Capping user text without tearing a character in half (#1038).
//
// `.slice(0, n)` counts UTF-16 code units, and an emoji is two of them, so a cap
// that lands inside one keeps only its high surrogate. That half is not a
// character: `JSON.stringify` writes it as a lone `\ud83d` escape, Foundation's
// JSON decoders (iOS) refuse the WHOLE document over it, and Node's UTF-8 encoder
// turns it into U+FFFD on a socket or in a file name.
//
// The cap stays in code units, so a length limit means what it meant before; the
// cut just steps back one unit when it would split a pair.

/** `text` cut to at most `max` UTF-16 code units, like `text.slice(0, max)`, but
 *  never ending on the high half of a surrogate pair. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
