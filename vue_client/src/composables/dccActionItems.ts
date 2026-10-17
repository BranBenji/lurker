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
import { useToastsStore } from '../stores/toasts.js';

export interface DccActionOptions {
  /** Runs before the action: a modal closing itself, say. */
  before?: () => void;
}

/** The chat and send entries for `nick`, each gated on the account's grant.
 *  Empty when DCC is off or the account has neither grant. */
export function dccActionItems(
  networkId: number,
  nick: string,
  opts: DccActionOptions = {},
): ContextMenuItem[] {
  const dcc = useDccStore();
  const items: ContextMenuItem[] = [];
  const chat = (secure: boolean) => async (): Promise<void> => {
    opts.before?.();
    try {
      await dcc.openChat(networkId, nick, false, secure);
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
  if (dcc.canChat) {
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
  return items;
}
