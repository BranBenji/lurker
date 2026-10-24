// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Periodic prune of expired -time ignore rules (issue #301). evaluateIgnores
// already honors expiry at call time, so a lapsed rule stops matching the
// instant it expires; this just deletes the row and tells the user's open tabs
// to drop it from the list so it doesn't linger in /ignore or the settings pane.

import ignoreRulesService from './ignoreRulesService.js';
import { fanOutIgnoreList, refreshDmReadState } from './wsHub.js';

const SWEEP_INTERVAL_MS = 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function sweepExpiredIgnores(): void {
  let affected: { userId: number; networkId: number | null }[];
  try {
    affected = ignoreRulesService.sweepExpired();
  } catch (e) {
    console.warn('[ignore] expiry sweep failed:', (e as Error)?.message || e);
    return;
  }
  // networkId null = a global rule lapsed; fanOutIgnoreList ships the right bucket.
  for (const { userId, networkId } of affected) fanOutIgnoreList(userId, networkId);
  // A lapsed `-time` mute un-mutes a DM's badge too (#1192): one DM walk per
  // user — every network when a global rule lapsed, else each touched network
  // once. The sweep doesn't know the lapsed rules' shapes, so it re-serves on
  // any lapse; expiries are rare and a minute apart.
  const scopes = new Map<number, Set<number> | null>();
  for (const { userId, networkId } of affected) {
    const cur = scopes.get(userId);
    if (cur === null) continue;
    if (networkId == null) scopes.set(userId, null);
    else (cur ?? scopes.set(userId, new Set()).get(userId)!).add(networkId);
  }
  for (const [userId, nets] of scopes) {
    if (nets === null) refreshDmReadState(userId, null);
    else for (const nid of nets) refreshDmReadState(userId, nid);
  }
}

export function startIgnoreSweeper(): void {
  if (timer) return;
  timer = setInterval(sweepExpiredIgnores, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopIgnoreSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
