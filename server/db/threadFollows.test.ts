// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The followed-thread list (#1225): what it lists, what it counts, and what it
// forgets. Following itself happens on insert (ircReplies.test.ts).

import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

setupTestDb('thread-follows');

let insertMessage: typeof import('./messages.js').insertMessage;
let tf: typeof import('./threadFollows.js');
let db: typeof import('./index.js').default;
let userId: number;
let networkId: number;
let seq = 0;

beforeAll(async () => {
  ({ insertMessage } = await import('./messages.js'));
  tf = await import('./threadFollows.js');
  ({ default: db } = await import('./index.js'));
  const { createUser } = await import('./users.js');
  const { createNetwork } = await import('./networks.js');
  userId = createUser('follower').id;
  networkId = createNetwork(userId, {
    name: 'n',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'me',
  })!.id;
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-24T12:00:00Z');

/** A thread in its own channel: a first line and one reply `ageDays` old. */
function thread(ageDays: number, fields: { self?: boolean; ignored?: boolean } = {}) {
  const target = `#t${seq++}`;
  const time = new Date(NOW - ageDays * DAY).toISOString();
  const root = `root-${target}`;
  const put = (extra: Record<string, unknown>) =>
    insertMessage({ networkId, target, time, type: 'message', nick: 'alice', text: 'x', ...extra });
  const { bufferId } = put({ msgid: root });
  const reply = put({
    replyMsgid: root,
    replyRootMsgid: root,
    self: fields.self,
    fromIgnored: fields.ignored,
    nick: fields.self ? 'me' : 'bob',
  });
  return { target, bufferId, root, replyId: Number(reply.id), put };
}

const listed = () => tf.listFollowedThreads(userId, NOW).map((t) => t.rootMsgid);
const rowCount = (bufferId: number) =>
  db.prepare(`SELECT count(*) FROM thread_follows WHERE buffer_id = ?`).pluck().get(bufferId);

describe('listFollowedThreads', () => {
  it('lists a quiet thread while it has something unread, and forgets it once read', () => {
    const t = thread(10);
    tf.followThreadIfAbsent(userId, t.bufferId, t.root, 0);
    expect(listed()).toContain(t.root);

    tf.markThreadRead(userId, t.bufferId, t.root, t.replyId);
    expect(listed()).not.toContain(t.root);
    expect(rowCount(t.bufferId)).toBe(0);
  });

  it('keeps a recent thread with nothing unread', () => {
    const t = thread(1);
    tf.followThreadIfAbsent(userId, t.bufferId, t.root, t.replyId);
    expect(tf.listFollowedThreads(userId, NOW).find((x) => x.rootMsgid === t.root)).toMatchObject({
      unread: 0,
      highlighted: false,
      target: t.target,
      root: { nick: 'alice', text: 'x' },
      lastReplyId: t.replyId,
    });
  });

  it('counts replies from others past the pointer, not our own or someone ignored’s', () => {
    const t = thread(1);
    tf.followThreadIfAbsent(userId, t.bufferId, t.root, 0);
    t.put({ replyMsgid: t.root, replyRootMsgid: t.root, self: true, nick: 'me' });
    t.put({ replyMsgid: t.root, replyRootMsgid: t.root, fromIgnored: true, nick: 'troll' });
    const hl = t.put({
      replyMsgid: t.root,
      replyRootMsgid: t.root,
      nick: 'carol',
      matchedRuleId: 1,
    });
    const got = tf.listFollowedThreads(userId, NOW).find((x) => x.rootMsgid === t.root)!;
    expect(got.unread).toBe(2);
    expect(got.highlighted).toBe(true);
    expect(got.lastReplyId).toBe(Number(hl.id));
  });

  it('forgets a follow whose replies retention took', () => {
    const t = thread(1);
    tf.followThreadIfAbsent(userId, t.bufferId, t.root, 0);
    db.prepare('DELETE FROM messages WHERE buffer_id = ? AND reply_root_msgid IS NOT NULL').run(
      t.bufferId,
    );
    expect(listed()).not.toContain(t.root);
    expect(rowCount(t.bufferId)).toBe(0);
  });

  it('says so when the first line is gone, and still lists the thread', () => {
    const t = thread(1);
    tf.followThreadIfAbsent(userId, t.bufferId, t.root, 0);
    db.prepare('DELETE FROM messages WHERE buffer_id = ? AND msgid = ?').run(t.bufferId, t.root);
    expect(tf.listFollowedThreads(userId, NOW).find((x) => x.rootMsgid === t.root)).toMatchObject({
      root: null,
      unread: 1,
    });
  });

  it('orders by newest reply', () => {
    const older = thread(3);
    const newer = thread(1);
    tf.followThreadIfAbsent(userId, older.bufferId, older.root, 0);
    tf.followThreadIfAbsent(userId, newer.bufferId, newer.root, 0);
    const roots = listed();
    expect(roots.indexOf(newer.root)).toBeLessThan(roots.indexOf(older.root));
  });
});

describe('noteThreadReply', () => {
  it('our own post follows the thread, read through the post', () => {
    const t = thread(1, { self: true });
    expect(
      tf.noteThreadReply(userId, t.bufferId, t.root, {
        id: t.replyId,
        self: true,
        highlighted: false,
      }),
    ).toBe(true);
    expect(tf.listFollowedThreads(userId, NOW).find((x) => x.rootMsgid === t.root)?.unread).toBe(0);
  });

  it('a highlight follows the thread, with that reply unread; a plain reply does not', () => {
    const plain = thread(1);
    expect(
      tf.noteThreadReply(userId, plain.bufferId, plain.root, {
        id: plain.replyId,
        self: false,
        highlighted: false,
      }),
    ).toBe(false);
    expect(listed()).not.toContain(plain.root);

    const hl = thread(1);
    expect(
      tf.noteThreadReply(userId, hl.bufferId, hl.root, {
        id: hl.replyId,
        self: false,
        highlighted: true,
      }),
    ).toBe(true);
    expect(tf.listFollowedThreads(userId, NOW).find((x) => x.rootMsgid === hl.root)?.unread).toBe(
      1,
    );
  });

  it('a reply in a thread we started follows it', () => {
    const target = `#t${seq++}`;
    const time = new Date(NOW - DAY).toISOString();
    const root = `root-${target}`;
    const { bufferId } = insertMessage({
      networkId,
      target,
      time,
      type: 'message',
      nick: 'me',
      text: 'mine',
      self: true,
      msgid: root,
    });
    const reply = insertMessage({
      networkId,
      target,
      time,
      type: 'message',
      nick: 'bob',
      text: 'theirs',
      replyMsgid: root,
      replyRootMsgid: root,
    });
    expect(
      tf.noteThreadReply(userId, bufferId, root, {
        id: Number(reply.id),
        self: false,
        highlighted: false,
      }),
    ).toBe(true);
    expect(listed()).toContain(root);
  });

  it('a plain reply in a followed thread reports the list changed, without moving the pointer', () => {
    const t = thread(1, { self: true });
    tf.noteThreadReply(userId, t.bufferId, t.root, {
      id: t.replyId,
      self: true,
      highlighted: false,
    });
    const r = t.put({ replyMsgid: t.root, replyRootMsgid: t.root, nick: 'bob' });
    expect(
      tf.noteThreadReply(userId, t.bufferId, t.root, {
        id: Number(r.id),
        self: false,
        highlighted: false,
      }),
    ).toBe(true);
    expect(tf.listFollowedThreads(userId, NOW).find((x) => x.rootMsgid === t.root)?.unread).toBe(1);
  });
});

describe('markThreadRead', () => {
  it('never moves the pointer back', () => {
    const t = thread(1);
    tf.followThreadIfAbsent(userId, t.bufferId, t.root, 0);
    expect(tf.markThreadRead(userId, t.bufferId, t.root, t.replyId)).toBe(true);
    expect(tf.markThreadRead(userId, t.bufferId, t.root, t.replyId - 1)).toBe(false);
    expect(tf.markThreadRead(userId, t.bufferId, t.root, t.replyId)).toBe(false);
  });

  it('does nothing for a thread that isn’t followed', () => {
    const t = thread(1);
    expect(tf.markThreadRead(userId, t.bufferId, t.root, t.replyId)).toBe(false);
    expect(rowCount(t.bufferId)).toBe(0);
  });
});
