// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { parseRelayChain, type RelayParse } from '../../../shared/parseRelay.js';

// Per-(network, nick) relay-bot marks (#277). A marked nick is a relay / bridge
// bot whose messages wrap another person's speech in an envelope; MessageList
// re-attributes those lines to the embedded speaker at render time. Server is
// the source of truth — marks ship over WS and a `relay-bot-updated` echo fans
// out to every session so the mark stays in sync across devices. Keying is
// network-scoped (same nick on different networks may be unrelated bots),
// mirroring nick notes and ignores.
function key(networkId: number | string, nick: string) {
  return `${networkId}::${(nick || '').toLowerCase()}`;
}

export interface RelayBotEntry {
  /** Canonical nick casing (server-provided) — the key is lowercased for
   *  case-insensitive lookup, so this preserves what to show in /relay list. */
  nick: string;
  /** Custom envelope template; empty string means "use the built-in defaults". */
  pattern: string;
}

export const useRelayBotsStore = defineStore('relayBots', {
  state: () => ({
    // { [networkId::nicklower]: { nick, pattern } } — presence of a key IS the mark.
    byKey: {} as Record<string, RelayBotEntry>,
  }),
  getters: {
    isRelay: (state) => (networkId: number | string, nick: string) =>
      !!state.byKey[key(networkId, nick)],
    // A line as the speaker inside its envelope, or null when it isn't one: not
    // a plain message from a marked bot (relays bridge speech as PRIVMSG, and a
    // notice or /me has its own rendering; never your own line), or its text
    // isn't an envelope. Chained bridges (#801): keeps unwrapping while the
    // speaker a hop reveals is itself a marked bot, so a relay of a relay lands
    // on the person who spoke rather than on the bridge in between. Everything
    // that shows a relayed line reads it through this — the timeline's rows,
    // search/activity/bookmark rows, and a reply's quote (#996) — so they agree.
    unwrap:
      (state) =>
      (
        networkId: number | string | null | undefined,
        line: { type?: string; nick?: string | null; self?: boolean; text?: string | null },
      ): RelayParse | null => {
        if (networkId == null || line.type !== 'message' || line.self || !line.nick) return null;
        const mark = (n: string) => state.byKey[key(networkId, n)];
        const outer = mark(line.nick);
        if (!outer) return null;
        return parseRelayChain(line.text ?? '', outer.pattern || '', (inner) => {
          const m = mark(inner);
          return m ? m.pattern || '' : null;
        });
      },
    // [{ nick, pattern }] for a given network — drives `/relay list`. Uses the
    // stored canonical nick for display, not the lowercased key.
    listForNetwork: (state) => (networkId: number) => {
      const prefix = `${networkId}::`;
      const out: Array<{ nick: string; pattern: string }> = [];
      for (const [k, entry] of Object.entries(state.byKey)) {
        if (k.startsWith(prefix)) out.push({ nick: entry.nick, pattern: entry.pattern });
      }
      return out;
    },
  },
  actions: {
    applySnapshot(networks: any[]) {
      const next: Record<string, RelayBotEntry> = {};
      for (const n of networks || []) {
        if (n?.networkId == null) continue;
        for (const entry of n.relayBots || []) {
          if (!entry?.nick) continue;
          next[key(n.networkId, entry.nick)] = { nick: entry.nick, pattern: entry.pattern || '' };
        }
      }
      this.byKey = next;
    },
    applyUpdate(networkId: number | string, nick: string, marked: boolean, pattern: string) {
      if (!networkId || !nick) return;
      const k = key(networkId, nick);
      if (marked) {
        // `nick` here is the canonical casing echoed by the server.
        this.byKey[k] = { nick, pattern: pattern || '' };
      } else {
        delete this.byKey[k];
      }
    },
    setRelay(networkId: number | string, nick: string, marked: boolean, pattern = '') {
      if (!networkId || !nick) return;
      socketSend({ type: 'set-relay-bot', networkId, nick, marked, pattern });
    },
  },
});
