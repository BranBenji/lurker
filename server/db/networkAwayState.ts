// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A row from the `network_away_state` table: one network's away cycle. */
export interface NetworkAwayState {
  network_id: number;
  user_id: number;
  away_datetime: string | null;
  back_datetime: string | null;
  away_message: string | null;
  auto_set: number;
}

const getStmt = db.prepare(`
  SELECT network_id, user_id, away_datetime, back_datetime, away_message, auto_set
  FROM network_away_state
  WHERE network_id = ?
`);

const listStmt = db.prepare(`
  SELECT network_id, user_id, away_datetime, back_datetime, away_message, auto_set
  FROM network_away_state
  WHERE user_id = ?
`);

// New /away: replace the prior row entirely. back_datetime is forced null so a
// completed pair from a previous away/back cycle gets cleared in the same write.
const writeAwayStmt = db.prepare(`
  INSERT INTO network_away_state
    (network_id, user_id, away_datetime, back_datetime, away_message, auto_set)
  VALUES (@networkId, @userId, @awayDatetime, NULL, @awayMessage, @autoSet)
  ON CONFLICT(network_id) DO UPDATE SET
    away_datetime = excluded.away_datetime,
    back_datetime = NULL,
    away_message = excluded.away_message,
    auto_set = excluded.auto_set
`);

// /back only fills in the matching back_datetime; away_datetime, away_message,
// and auto_set stay so the client can render the completed pair. No-op if
// no row exists (writeAwayMarker hasn't run yet).
const writeBackStmt = db.prepare(`
  UPDATE network_away_state
  SET back_datetime = @backDatetime
  WHERE network_id = @networkId
`);

export function getNetworkAwayState(networkId: number): NetworkAwayState | null {
  return (getStmt.get(networkId) as NetworkAwayState | undefined) ?? null;
}

/** Every network's away row for a user. A network that was never away has none. */
export function listNetworkAwayStates(userId: number): NetworkAwayState[] {
  return listStmt.all(userId) as NetworkAwayState[];
}

/** Whether a row stands for an away that hasn't ended. */
export function isAwayRow(row: NetworkAwayState | null | undefined): boolean {
  return !!row?.away_datetime && !row.back_datetime;
}

export function writeAwayMarker(
  userId: number,
  networkId: number,
  {
    awayDatetime,
    awayMessage,
    autoSet,
  }: { awayDatetime: string; awayMessage?: string | null; autoSet?: boolean },
): void {
  writeAwayStmt.run({
    networkId,
    userId,
    awayDatetime,
    awayMessage: awayMessage ?? null,
    autoSet: autoSet ? 1 : 0,
  });
}

export function writeBackMarker(networkId: number, backDatetime: string): void {
  writeBackStmt.run({ networkId, backDatetime });
}
