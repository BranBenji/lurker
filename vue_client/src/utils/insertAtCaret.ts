// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * Put `insert` in place of the selection [start, end) of `text`, with a space
 * either side where the neighbouring character isn't already whitespace: an
 * uploaded file's URL dropped into a composer mid-sentence. Returns the new
 * text and where the caret goes (just after the insert and its padding).
 */
export function insertWithPadding(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const padLeft = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const padRight = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  const inserted = `${padLeft}${insert}${padRight}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
