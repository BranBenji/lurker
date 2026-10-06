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
// So the cut falls between graphemes, as clampPushText's does: a flag, a ZWJ
// family or a skin-toned hand is kept whole or dropped whole, never left as a
// stray letter or a dangling joiner. The cap stays in code units, so a length
// limit means what it meant before.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** `text` cut to at most `max` UTF-16 code units, like `text.slice(0, max)`, but
 *  only ever between two graphemes. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  // Whether a grapheme ends AT the cut depends on the code point after it (a
  // combining mark or a skin tone would extend it), so segment one code point
  // past the cut, and no further: the rest can't move a break before it.
  let end = 0;
  for (const { index, segment } of graphemes.segment(text.slice(0, max + 2))) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  if (end > 0) return text.slice(0, end);
  // The first grapheme alone outruns the cap (a pile of combining marks). Cut
  // inside it, but still between code points.
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
