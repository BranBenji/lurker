// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// capText's twin for a budget counted in UTF-8 bytes (#1051).
//
// Some limits are bytes, not characters: ext4 and APFS allow 255 BYTES per file
// name, and an emoji is two UTF-16 units but four bytes, a CJK character one
// unit but three. A cap by `.length` lets either through at twice or three times
// the limit.
//
// The cut falls between graphemes, as capText's does, so a flag or a ZWJ family
// is kept whole or dropped whole. A lone surrogate counts as the three bytes of
// the U+FFFD it encodes as, which is what lands on disk or on the wire.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The UTF-8 encoded length of `text`. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** `text` cut to at most `maxBytes` bytes of UTF-8, only ever between two
 *  graphemes. */
export function capUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  if (maxBytes <= 0) return '';
  // Every code unit is at least one byte, so nothing past `maxBytes` units can
  // fit. Segment one code point past that, as capText does, so the grapheme
  // ending at the cut sees what follows it.
  let end = 0;
  let bytes = 0;
  for (const { segment } of graphemes.segment(text.slice(0, maxBytes + 2))) {
    bytes += utf8Bytes(segment);
    if (bytes > maxBytes) break;
    end += segment.length;
  }
  if (end > 0) return text.slice(0, end);
  // The first grapheme alone outruns the budget (a pile of combining marks).
  // Cut inside it, but still between code points.
  bytes = 0;
  for (const cp of text) {
    bytes += utf8Bytes(cp);
    if (bytes > maxBytes) break;
    end += cp.length;
  }
  return text.slice(0, end);
}
