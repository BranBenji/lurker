// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';
import { DRAFT_REPLY_PARENT_COL, draftReplyFrom, replySendMsgid } from './messages.js';
import type { DraftReply, DraftReplyRef } from '../../shared/replies.js';

// Keyed (user_id, buffer_id) since schema 18. Signatures unchanged — callers
// hold names; resolution happens here, scoped to the CALLER's userId (not
// derived from the network) so a mismatched (userId, networkId) pair can
// never write rows referencing another user's buffers — the satellite FK
// points at buffers(id) alone, so ownership is this layer's job. A miss on
// add is a silent drop (input history for a buffer that doesn't exist has
// nowhere to live and nothing to replay it).

const insertStmt = db.prepare(`
  INSERT INTO input_history (user_id, buffer_id, text, reply_message_id, reply_addressed)
  VALUES (?, ?, ?, ?, ?)
`);

// Qualified: inside the lookup's subquery a bare `buffer_id` is the message's.
const listRecentStmt = db.prepare(`
  SELECT h.text AS text,
         ${DRAFT_REPLY_PARENT_COL('h.reply_message_id', 'h.buffer_id')} AS replyParent,
         h.reply_addressed AS replyAddressed
  FROM input_history h
  WHERE h.user_id = ? AND h.buffer_id = ?
  ORDER BY h.id DESC
  LIMIT ?
`);

// `reply`: the line the entry was sent as a reply to, so recalling it brings the
// reply back with the text. Kept only when it names a line a reply here can,
// as a draft's is (upsertDraft).
export function addEntry(
  userId: number,
  networkId: number,
  target: string,
  text: string,
  reply: DraftReplyRef | null = null,
): void {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return;
  const valid = reply && replySendMsgid(userId, networkId, target, reply.messageId) !== null;
  insertStmt.run(
    userId,
    buffer.id,
    text,
    valid ? reply.messageId : null,
    valid && reply.addressed ? 1 : 0,
  );
}

export interface InputHistoryEntry {
  text: string;
  reply: DraftReply | null;
}

// Returns the `limit` most recent entries, oldest-first — the order the client
// wants for up-arrow walking (index N-1 is newest, walk backwards toward 0).
// The table itself is uncapped; this slice is just what we ship on snapshot.
export function listRecentEntries(
  userId: number,
  networkId: number,
  target: string,
  limit = 200,
): InputHistoryEntry[] {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return [];
  const rows = listRecentStmt.all(userId, buffer.id, limit) as Array<{
    text: string;
    replyParent: string | null;
    replyAddressed: number;
  }>;
  return rows
    .map((row) => ({ text: row.text, reply: draftReplyFrom(row.replyParent, row.replyAddressed) }))
    .toReversed();
}

export function listRecent(
  userId: number,
  networkId: number,
  target: string,
  limit = 200,
): string[] {
  return listRecentEntries(userId, networkId, target, limit).map((e) => e.text);
}

// What a buffer's frames carry for up-arrow recall: `inputHistory` as it always
// was (a client that knows nothing of replies reads it unchanged), and beside it
// `inputHistoryReplies`, index for index, only when an entry has one.
export function inputHistoryFields(
  userId: number,
  networkId: number,
  target: string,
  limit: number,
): { inputHistory: string[]; inputHistoryReplies?: Array<DraftReply | null> } {
  const entries = listRecentEntries(userId, networkId, target, limit);
  const inputHistory = entries.map((e) => e.text);
  if (!entries.some((e) => e.reply)) return { inputHistory };
  return { inputHistory, inputHistoryReplies: entries.map((e) => e.reply) };
}
