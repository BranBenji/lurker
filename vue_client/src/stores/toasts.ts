// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';

let nextId = 1;

// Action callbacks live module-local, keyed by toast id — never in Pinia state.
// The store keeps only the serializable `{ label }` so $reset / devtools /
// persistence never have to deal with a function (same rationale as the
// drafts store's module-local timers). Registered in push(), cleared in
// dismiss()/clear() so the map can't outlive its toast.
const actionHandlers = new Map<number, Array<() => void>>();

export type ToastKind =
  | 'highlight'
  | 'dm'
  | 'always_notify'
  | 'kicked'
  | 'notify'
  | 'info'
  | 'warn'
  | 'error';

// An explicit call-to-action button rendered inside the toast (e.g. the "Join"
// on a channel-invite toast). Distinct from the whole-toast click, which only
// activates an existing buffer — an action can run any handler, so it's the
// primitive for toasts that offer to *do* something rather than navigate. The
// handler is split off into the module-local map above; only `label` is stored.
export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Colours the button: an accept reads good, a decline bad, a "later" muted. */
  tone?: 'good' | 'bad' | 'muted';
}

/** The serializable half of a ToastAction, as the store keeps it. */
export interface ToastActionLabel {
  label: string;
  tone?: 'good' | 'bad' | 'muted';
}

export interface Toast {
  id: number;
  title: string;
  body: string;
  networkId?: number;
  target?: string;
  messageId?: number;
  kind: ToastKind;
  // Serializable subset of each ToastAction — the onClicks are held in
  // actionHandlers, in the same order.
  actions?: ToastActionLabel[];
  /** False hides the × — for a toast that asks a question every button of
   *  which answers it (a DCC offer: Accept · Decline · Later, #1085). */
  dismissible?: boolean;
}

export interface ToastOptions {
  title: string;
  body: string;
  networkId?: number;
  target?: string;
  messageId?: number;
  kind?: ToastKind;
  ttlMs?: number;
  /** One button. Shorthand for `actions: [action]`. */
  action?: ToastAction;
  /** Several buttons, in order. */
  actions?: ToastAction[];
  dismissible?: boolean;
}

export const useToastsStore = defineStore('toasts', {
  state: () => ({
    items: [] as Toast[],
  }),
  actions: {
    push({
      title,
      body,
      networkId,
      target,
      messageId,
      kind = 'highlight',
      ttlMs = 5000,
      action,
      actions,
      dismissible,
    }: ToastOptions) {
      const id = nextId++;
      const all = actions ?? (action ? [action] : []);
      if (all.length)
        actionHandlers.set(
          id,
          all.map((a) => a.onClick),
        );
      this.items.push({
        id,
        title,
        body,
        networkId,
        target,
        messageId,
        kind,
        actions: all.length ? all.map(({ label, tone }) => ({ label, tone })) : undefined,
        dismissible,
      });
      if (ttlMs > 0) {
        setTimeout(() => this.dismiss(id), ttlMs);
      }
      return id;
    },
    // Run one of a toast's action handlers (looked up module-local, not from
    // state); the first when no index is given.
    runAction(id: number, index = 0) {
      actionHandlers.get(id)?.[index]?.();
    },
    dismiss(id: number) {
      actionHandlers.delete(id);
      const idx = this.items.findIndex((t) => t.id === id);
      if (idx >= 0) this.items.splice(idx, 1);
    },
    clear() {
      actionHandlers.clear();
      this.items = [];
    },
  },
});
