// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-(user, network) ignore-rule cache + write path (issue #301). Mirrors
// highlightRulesService: getCompiled() caches the compiled rule set used on the
// insert hot path; every mutation invalidates so ircConnection's stamp/highlight
// decisions never read a stale set.

import type { IgnoreRuleRow, IgnoreRuleInput } from '../db/ignoredMasks.js';
import {
  addRule,
  removeRuleById,
  removeRuleByMask,
  listRules,
  listGlobalRules,
  listScopedRules,
  sweepExpired as sweepExpiredRows,
} from '../db/ignoredMasks.js';
import { compileIgnoreRules, canonicalizeLevels } from './ignoreMatch.js';

type Compiled = ReturnType<typeof compileIgnoreRules>;

const ALLOWED_KINDS = new Set(['substr', 'full', 'regex']);
const MAX_PATTERN_LENGTH = 512;

class IgnoreRulesService {
  // Keyed by `${userId}:${networkId}`; getCompiled is only ever called with a
  // real networkId — a live connection's insert path, or any network with an
  // unread DM when its counts are served (#1192) — so we never key on a null
  // network.
  private cache = new Map<string, Compiled>();

  private key(userId: number, networkId: number): string {
    return `${userId}:${networkId}`;
  }

  /** A single network's own rules (excludes globals) — for the per-network UI bucket. */
  list(userId: number, networkId: number): IgnoreRuleRow[] {
    return listRules({ userId, networkId });
  }

  /** The user's global rules — for the global UI bucket. */
  listGlobal(userId: number): IgnoreRuleRow[] {
    return listGlobalRules(userId);
  }

  add(
    userId: number,
    networkId: number | null,
    input: IgnoreRuleInput,
  ): { ok: false; error: string } | { ok: true; id: number; created: boolean } {
    if (!ALLOWED_KINDS.has(input.patternKind)) {
      return { ok: false, error: 'pattern kind must be substr, full, or regex' };
    }
    if (input.pattern && input.pattern.length > MAX_PATTERN_LENGTH) {
      return { ok: false, error: `pattern exceeds ${MAX_PATTERN_LENGTH} chars` };
    }
    if (input.pattern && input.patternKind === 'regex') {
      try {
        void new RegExp(input.pattern);
      } catch (e) {
        return { ok: false, error: `invalid regex: ${(e as Error).message}` };
      }
    }
    const levels = canonicalizeLevels(input.levels);
    if (levels.length === 0) {
      return { ok: false, error: 'at least one valid level is required' };
    }
    // expiresAt arrives from an untrusted WS payload. Reject anything Date.parse
    // can't read (a NaN would make the rule never expire and never sweep), and
    // canonicalize to ISO so the DB stores one consistent format.
    let expiresAt = input.expiresAt;
    if (expiresAt != null) {
      const t = Date.parse(expiresAt);
      if (Number.isNaN(t)) return { ok: false, error: 'invalid expiry timestamp' };
      expiresAt = new Date(t).toISOString();
    }
    // A rule with no who/where/what AND only ALL would hide the whole network —
    // allow it (irssi does), but a fully-empty rule (no mask, no channels, no
    // pattern) with no real effect is still stored; the matcher makes it inert.
    const { id, created } = addRule({ userId, networkId, rule: { ...input, levels, expiresAt } });
    this.invalidate(userId, networkId);
    return { ok: true, id, created };
  }

  removeById(userId: number, networkId: number | null, id: number): boolean {
    const ok = removeRuleById({ userId, id });
    if (ok) this.invalidate(userId, networkId);
    return ok;
  }

  removeByMask(userId: number, networkId: number | null, mask: string): number {
    const n = removeRuleByMask({ userId, networkId, mask });
    // A by-mask delete can touch both globals and the network's own rules, so
    // drop every cache entry for the user rather than reason about which.
    if (n) this.invalidate(userId, null);
    return n;
  }

  // The compiled set for one network is globals ∪ that network's rules.
  getCompiled(userId: number, networkId: number): Compiled {
    const k = this.key(userId, networkId);
    const cached = this.cache.get(k);
    if (cached) return cached;
    const compiled = compileIgnoreRules(listScopedRules({ userId, networkId }));
    this.cache.set(k, compiled);
    return compiled;
  }

  // A global rule (networkId null) feeds every network's compiled set, so drop
  // all of the user's entries; a network-scoped change drops only that one.
  invalidate(userId: number, networkId: number | null): void {
    if (networkId == null) {
      const prefix = `${userId}:`;
      for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
    } else {
      this.cache.delete(this.key(userId, networkId));
    }
  }

  // Delete every lapsed rule, invalidate the caches it touched, and return the
  // affected (user, network) pairs so the caller can fan out updated lists.
  sweepExpired(): { userId: number; networkId: number | null }[] {
    const affected = sweepExpiredRows();
    for (const { userId, networkId } of affected) this.invalidate(userId, networkId);
    return affected;
  }
}

const ignoreRulesService = new IgnoreRulesService();
export default ignoreRulesService;
