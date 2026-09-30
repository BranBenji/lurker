// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';
import { DRAFT_REPLY_PARENT_COL, draftReplyFrom, replySendMsgid } from './messages.js';
import type { DraftReply, DraftReplyRef } from '../../shared/replies.js';

// Keyed (user_id, buffer_id) since schema 18; the snapshot joins back through
// `buffers` so the wire shape (networkId + target per draft) is unchanged.

/** A draft row returned to callers (camelCase aliased columns). */
export interface DraftRow {
  bufferId: number;
  networkId: number;
  target: string;
  body: string;
  updatedAt: string;
  // The line the draft replies to, resolved as a reply's quote is; null when it
  // has none, or the line is gone or no longer one a reply can name.
  reply: DraftReply | null;
}

interface RawDraftRow extends Omit<DraftRow, 'reply'> {
  replyParent: string | null;
  replyAddressed: number;
}

function toDraftRow({ replyParent, replyAddressed, ...row }: RawDraftRow): DraftRow {
  return { ...row, reply: draftReplyFrom(replyParent, replyAddressed) };
}

// The body only: a client that sends no reply field (one that doesn't know
// about replies) leaves the stored reply as it is.
const upsertStmt = db.prepare(`
  INSERT INTO user_drafts (user_id, buffer_id, body, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, buffer_id) DO UPDATE SET
    body = excluded.body,
    updated_at = excluded.updated_at
`);

const upsertWithReplyStmt = db.prepare(`
  INSERT INTO user_drafts (user_id, buffer_id, body, reply_message_id, reply_addressed, updated_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, buffer_id) DO UPDATE SET
    body = excluded.body,
    reply_message_id = excluded.reply_message_id,
    reply_addressed = excluded.reply_addressed,
    updated_at = excluded.updated_at
`);

const clearStmt = db.prepare(`
  DELETE FROM user_drafts
   WHERE user_id = ? AND buffer_id = ?
`);

const DRAFT_COLS = `d.buffer_id AS bufferId, b.network_id AS networkId, b.target AS target,
         d.body AS body, d.updated_at AS updatedAt,
         ${DRAFT_REPLY_PARENT_COL('d.reply_message_id', 'd.buffer_id')} AS replyParent,
         d.reply_addressed AS replyAddressed`;

const listStmt = db.prepare(`
  SELECT ${DRAFT_COLS}
    FROM user_drafts d JOIN buffers b ON b.id = d.buffer_id
   WHERE d.user_id = ?
`);

/** Returns the buffer id the draft landed on (undefined = unknown buffer,
 *  no-op) so the draft-updated fanout can carry it without a second resolve.
 *  `reply`: undefined leaves the stored one; null clears it; a ref sets it —
 *  unless it names a line a reply here can't (not the user's to see, another
 *  buffer's, no msgid), which clears it: the server re-checks at send anyway. */
export function upsertDraft(
  userId: number,
  networkId: number,
  target: string,
  body: string,
  reply?: DraftReplyRef | null,
): number | undefined {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return undefined;
  if (reply === undefined) {
    upsertStmt.run(userId, buffer.id, body);
    return buffer.id;
  }
  const valid = reply && replySendMsgid(userId, networkId, target, reply.messageId) !== null;
  upsertWithReplyStmt.run(
    userId,
    buffer.id,
    body,
    valid ? reply.messageId : null,
    valid && reply.addressed ? 1 : 0,
  );
  return buffer.id;
}

export function clearDraft(userId: number, networkId: number, target: string): number | undefined {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return undefined;
  clearStmt.run(userId, buffer.id);
  return buffer.id;
}

// Returns every draft for this user as plain objects — the snapshot ships
// across the wire on connect (and on a tab-visibility resync).
export function listForUser(userId: number): DraftRow[] {
  return (listStmt.all(userId) as RawDraftRow[]).map(toDraftRow);
}

const getForBufferStmt = db.prepare(`
  SELECT ${DRAFT_COLS}
    FROM user_drafts d JOIN buffers b ON b.id = d.buffer_id
   WHERE d.user_id = ? AND d.buffer_id = ?
`);

/** Point read by buffer id — the rename/merge announcement uses this to ship
 *  the surviving draft. */
export function getDraftForBuffer(userId: number, bufferId: number): DraftRow | undefined {
  const row = getForBufferStmt.get(userId, bufferId) as RawDraftRow | undefined;
  return row ? toDraftRow(row) : undefined;
}
