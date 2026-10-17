// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DCC entries every menu on a person carries (#1085, #1157): the nick
// menu, a DM's or DCC chat's buffer menu, and the profile's ⋯ menu. One list,
// so they cannot drift. KVIrc's menu is the model, minus its reverse entries:
// passive is the server's call when it can't listen (a send goes passive on
// its own; a chat says to use `/dcc chat -passive`, since few clients take
// one), not a choice to offer everyone. Turbo (TDCC) is unsupported.

import { FileUpIcon, LockIcon, MessageSquareIcon } from '@lucide/vue';

import type { ContextMenuItem } from './useContextMenu.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useDccStore } from '../stores/dcc.js';
import { useNetworksStore } from '../stores/networks.js';
import { useToastsStore } from '../stores/toasts.js';

export interface DccActionOptions {
  /** Runs before the action: a modal closing itself, say. */
  before?: () => void;
}

/** The DCC section of a menu on `nick`: a divider, a "DCC" heading, and the
 *  chat and send entries, each pair gated on the account's grant. Empty when
 *  DCC is off or the account has neither grant, so a caller can spread it in
 *  unconditionally. The section ends where the menu does, or at the caller's
 *  next divider. */
export function dccActionItems(
  networkId: number,
  nick: string,
  opts: DccActionOptions = {},
): ContextMenuItem[] {
  const dcc = useDccStore();
  const items: ContextMenuItem[] = [];
  const chat = (secure: boolean) => async (): Promise<void> => {
    try {
      await dcc.openChat(networkId, nick, false, secure);
      // Only now: a modal that closed itself before a failed request would
      // leave the toast below as the only trace.
      opts.before?.();
      // As `/dcc chat` does: the `=nick` buffer materializes from the server's
      // first notice, so activate by target — it may not exist for a tick.
      useBuffersStore().activate(networkId, `=${nick}`);
    } catch (e: any) {
      // The server's own refusals arrive as notices in the buffer; this is the
      // request itself failing, which would otherwise vanish.
      useToastsStore().push({
        kind: 'info',
        title: `DCC chat with ${nick}`,
        body: e?.message || 'failed',
        ttlMs: 5000,
      });
    }
  };
  // Not while a chat with them is up: the server would only answer "Already
  // in a DCC chat", and the `=nick` buffer's own menu is where that shows.
  if (dcc.canChat && !useNetworksStore().isDccChatLive(networkId, nick)) {
    items.push(
      { label: 'Chat (DCC)', icon: MessageSquareIcon, onClick: chat(false) },
      { label: 'Secure Chat (DCC)', icon: LockIcon, onClick: chat(true) },
    );
  }
  // Sending starts from the person (#1085), never the composer: the paperclip
  // only shares. Opens the DCC window picking a file for them.
  if (dcc.canSend) {
    const send = (secure: boolean) => (): void => {
      opts.before?.();
      dcc.openSendTo(networkId, nick, secure);
    };
    items.push(
      { label: 'Send File (DCC)…', icon: FileUpIcon, onClick: send(false) },
      { label: 'Secure Send File (DCC)…', icon: LockIcon, onClick: send(true) },
    );
  }
  return items.length ? [{ divider: true }, { heading: 'DCC' }, ...items] : [];
}
