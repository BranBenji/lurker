// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { computed, type ComputedRef } from 'vue';
import { useRoute, type Router } from 'vue-router';

// Reply threads (#1225) are routes: `/buffer/:id/thread/:root` shows one thread
// (`?focus=<message id>` names the reply to bring into view) and
// `/buffer/:id/threads` lists the buffer's. The buffer itself is activated by
// useBufferRoute exactly as for `/buffer/:id` — its routeId() reads the same
// `:id` — so this only says which panel is up. On desktop the panel takes the
// member column; on mobile it is a screen over the buffer, so Back walks
// thread → buffer → list like the members screen.

export type ThreadRoute =
  | { mode: 'thread'; bufferId: number; rootMsgid: string; focusId: number | null }
  | { mode: 'list'; bufferId: number };

export function useThreadRoute(): ComputedRef<ThreadRoute | null> {
  const route = useRoute();
  return computed(() => {
    const id = Number(route.params.id);
    if (!Number.isInteger(id)) return null;
    if (route.name === 'buffer-threads') return { mode: 'list', bufferId: id };
    if (route.name !== 'buffer-thread') return null;
    const root = route.params.root;
    if (typeof root !== 'string' || !root) return null;
    const focus = Number(route.query.focus);
    return {
      mode: 'thread',
      bufferId: id,
      rootMsgid: root,
      focusId: Number.isInteger(focus) && focus > 0 ? focus : null,
    };
  });
}

// What something wants shown: a thread, the list, or the buffer alone again.
export type ThreadNav =
  | { kind: 'thread'; bufferId: number; rootMsgid: string; focusId?: number | null }
  | { kind: 'list'; bufferId: number }
  | { kind: 'close'; bufferId: number };

type Listener = (nav: ThreadNav) => void;
const listeners = new Set<Listener>();

// A chip in the message list, a slash command and a jump into a hidden reply
// all open a thread, from components that have no router of their own (and
// are mounted without one in tests). They ask here; the chat shells answer
// with the navigation (onThreadNav), as useJumpIntent does for jumps.
export function requestThreadNav(nav: ThreadNav): void {
  for (const listener of listeners) {
    try {
      listener(nav);
    } catch (_) {
      // A misbehaving listener must not strand the originating click.
    }
  }
}

export function onThreadNav(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Navigate as a ThreadNav asks — the shells' answer to requestThreadNav. A
 *  navigation of its own each time, so Back returns to where the user was. */
export function navigateThread(router: Router, nav: ThreadNav): void {
  if (nav.kind === 'close') {
    void router.push(`/buffer/${nav.bufferId}`);
    return;
  }
  if (nav.kind === 'list') {
    void router.push({ name: 'buffer-threads', params: { id: String(nav.bufferId) } });
    return;
  }
  void router.push({
    name: 'buffer-thread',
    params: { id: String(nav.bufferId), root: nav.rootMsgid },
    query: nav.focusId ? { focus: String(nav.focusId) } : {},
  });
}
