// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import { upsertDraft, clearDraft, listForUser, getDraftForBuffer } from '../db/drafts.js';
import type { DraftReplyRef } from '../../shared/replies.js';

// Per-buffer drafts are last-write-wins by updated_at — no merging, no CRDT.
// The conflict surface is tiny in practice (you don't actively type into the
// same buffer on two devices simultaneously), so this service just upserts and
// emits a `change` for wsHub to fan out to every other tab of the same user.
//
// A draft with nothing in it is a delete: the row is sparse on disk, and clients
// expect "no draft" rather than "draft with empty string" so the pencil chip
// can drive itself off `hasDraft` without extra trim checks. Nothing means no
// text AND no reply: a Reply with nothing typed yet (on your own line, in a DM,
// where it inserts no address) is a draft all the same, and follows you to
// another device like one.
//
// `reply` (see upsertDraft): undefined leaves the stored one, null clears it.
// The change announces the reply as it was stored and resolved, which is not
// always what was sent: one naming a line a reply can't is dropped.
class DraftsService extends EventEmitter {
  set(
    userId: number,
    networkId: number,
    target: string,
    body: unknown,
    reply: DraftReplyRef | null | undefined,
    originWs: unknown = null,
  ): void {
    const text = typeof body === 'string' ? body : '';
    if (text.length === 0 && !reply) {
      this.clear(userId, networkId, target, originWs);
      return;
    }
    const bufferId = upsertDraft(userId, networkId, target, text, reply);
    if (bufferId === undefined) return; // unknown buffer — nothing stored, nothing to announce
    const stored = getDraftForBuffer(userId, bufferId);
    if (!stored?.body && !stored?.reply) {
      // Only a reply, and it didn't hold.
      this.clear(userId, networkId, target, originWs);
      return;
    }
    this.emit('change', {
      userId,
      networkId,
      target,
      bufferId,
      body: stored.body,
      reply: stored.reply,
      originWs,
    });
  }

  clear(userId: number, networkId: number, target: string, originWs: unknown = null): void {
    const bufferId = clearDraft(userId, networkId, target);
    if (bufferId === undefined) return;
    this.emit('change', { userId, networkId, target, bufferId, body: '', reply: null, originWs });
  }

  snapshotForUser(userId: number): unknown[] {
    return listForUser(userId);
  }
}

const draftsService = new DraftsService();
export default draftsService;
