// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The id-list driver every filter-only feed page shares (search, highlights,
// reactions): `<column> IN (half UNION ALL half …)`, each half one bounded
// probe — a partial index seeked by buffer, or a per-network / per-nick walk
// that stops at its own LIMIT. SQLite walks the IN list in id order, so the
// outer ORDER BY needs no sort and the outer LIMIT stops the table fetches at
// a page's worth; the whole statement costs the halves, never the table.
//
// ⚠ A half must apply EXACTLY the row filters the outer query applies: a
// half that admitted a row the page then dropped would cut its own tail
// short, silently, on every later page too. Build both from one list.
//
// SQLite caps one compound at SQLITE_MAX_COMPOUND_SELECT (500) terms, so the
// halves are nested in chunks: a chain of chunks, each a chain of halves. No
// cap on halves, and the plan is the same for each (messagesEqp.test.ts).
const COMPOUND_CHUNK = 200;

export function idInHalves(column: string, halves: string[]): string {
  const chunks: string[] = [];
  for (let i = 0; i < halves.length; i += COMPOUND_CHUNK) {
    chunks.push(`SELECT id FROM (${halves.slice(i, i + COMPOUND_CHUNK).join(' UNION ALL ')})`);
  }
  return `${column} IN (${chunks.join(' UNION ALL ')})`;
}
