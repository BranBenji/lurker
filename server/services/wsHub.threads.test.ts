// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Reply threads over a real socket (#1225): the followed list in the connect
// burst, the `thread` and `threads` reads the panel opens with, and
// `thread-read`, answered with the whole list to every tab. What makes a thread
// followed in the first place is covered where it happens, on insert
// (ircReplies.test.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-threads');

const CHANNEL = '#threads';

let server: http.Server;
let userId: number;
let otherUserId: number;
let networkId: number;
let bufferId: number;
let createSession: typeof import('../db/sessions.js').createSession;
let url: string;
const ids: Record<string, number> = {};

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const { followThread } = await import('../db/threadFollows.js');
  const buffers = await import('../db/buffers.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('threaduser').id;
  otherUserId = createUser('someoneelse').id;
  const net = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'me',
  });
  networkId = net!.id;
  buffers.ensureExists(userId, networkId, CHANNEL);
  bufferId = buffers.getBuffer(userId, networkId, CHANNEL)!.id;

  const put = (
    key: string,
    nick: string,
    fields: { msgid?: string; reply?: string; root?: string; self?: boolean } = {},
  ) => {
    ids[key] = Number(
      insertMessage({
        networkId,
        target: CHANNEL,
        time: new Date().toISOString(),
        type: 'message',
        nick,
        text: key,
        self: fields.self ?? false,
        msgid: fields.msgid,
        replyMsgid: fields.reply,
        replyRootMsgid: fields.root,
      }).id,
    );
  };
  put('question', 'alice', { msgid: 'q' });
  put('answer', 'me', { msgid: 'a', reply: 'q', root: 'q', self: true });
  put('elsewhere', 'dave', { msgid: 'e' });
  put('follow-up', 'bob', { msgid: 'f', reply: 'a', root: 'q' });
  put('aside', 'carol', { msgid: 'g', reply: 'e', root: 'e' });
  // Read through our own answer: bob's follow-up is unread.
  followThread(userId, bufferId, 'q', ids.answer);

  server = http.createServer();
  attachWsHub(server, 'threads-test-secret');
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  testDb.cleanup();
});

type Frame = Record<string, unknown>;

/**
 * Connect as `who`, collect the burst, then send `request` (if any) and resolve
 * with every frame up to the first `until` after it — or the burst's frames
 * when there's no request.
 */
function session(
  request: Frame | null,
  until: string,
  who = () => userId,
): Promise<{ burst: Frame[]; after: Frame[] }> {
  return new Promise((resolve, reject) => {
    const { token } = createSession(who());
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const burst: Frame[] = [];
    const after: Frame[] = [];
    let sent = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no ${until}; after the request: ${after.map((f) => f.kind).join(', ')}`));
    }, 3000);
    const done = () => {
      clearTimeout(timer);
      ws.close();
      resolve({ burst, after });
    };
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (!sent) {
        burst.push(frame);
        if (frame.kind !== 'backlog-complete') return;
        if (!request) return done();
        sent = true;
        ws.send(JSON.stringify(request));
        return;
      }
      after.push(frame);
      if (frame.kind === until) done();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('reply threads over the socket', () => {
  it('the connect burst carries the followed list', async () => {
    const { burst } = await session(null, '');
    const frame = burst.find((f) => f.kind === 'threads-changed');
    expect(frame?.threads).toEqual([
      {
        networkId,
        bufferId,
        target: CHANNEL,
        rootMsgid: 'q',
        root: {
          id: ids.question,
          nick: 'alice',
          type: 'message',
          text: 'question',
          userhost: null,
        },
        unread: 1,
        highlighted: false,
        lastReplyId: ids['follow-up'],
        lastReplyTime: expect.any(String),
      },
    ]);
  });

  it('a timeline page’s first line carries its thread; every reply its root', async () => {
    // The offline network's channel arrives as a shell; hydrate it as a client does.
    const { after } = await session(
      { type: 'history', mode: 'latest', networkId, target: CHANNEL, limit: 50 },
      'history',
    );
    const page = after.find((f) => f.kind === 'history') as
      | (Frame & { events: Frame[] })
      | undefined;
    const byText = (text: string) => page!.events.find((e) => e.text === text)!;
    expect(byText('question').thread).toEqual({ replies: 2, lastReplyTime: expect.any(String) });
    expect(byText('answer')).not.toHaveProperty('thread');
    expect(byText('answer').replyTo).toMatchObject({ msgid: 'q', root: 'q' });
    expect(byText('follow-up').replyTo).toMatchObject({ msgid: 'a', root: 'q' });
  });

  it('`thread` answers with the first line and every reply, oldest first', async () => {
    const { after } = await session(
      { type: 'thread', bufferId, rootMsgid: 'q', token: 7 },
      'thread',
    );
    const reply = after.find((f) => f.kind === 'thread') as Frame & {
      root: Frame;
      replies: Frame[];
    };
    expect(reply).toMatchObject({ bufferId, networkId, target: CHANNEL, rootMsgid: 'q', token: 7 });
    expect(reply.root).toMatchObject({ id: ids.question, thread: { replies: 2 } });
    expect(reply.replies.map((r) => r.text)).toEqual(['answer', 'follow-up']);
    expect(reply.replies[1]).toMatchObject({ replyTo: { msgid: 'a', root: 'q' } });
    expect(reply.truncated).toBe(false);
  });

  it('`thread` for someone else’s buffer is answered empty', async () => {
    const { after } = await session(
      { type: 'thread', bufferId, rootMsgid: 'q', token: 3 },
      'thread',
      () => otherUserId,
    );
    expect(after.find((f) => f.kind === 'thread')).toMatchObject({
      token: 3,
      root: null,
      replies: [],
    });
  });

  it('`threads` lists the buffer’s threads, newest activity first', async () => {
    const { after } = await session({ type: 'threads', bufferId, token: 9 }, 'threads');
    const frame = after.find((f) => f.kind === 'threads') as Frame & { threads: Frame[] };
    expect(frame).toMatchObject({ bufferId, networkId, target: CHANNEL, token: 9 });
    expect(frame.threads).toEqual([
      {
        rootMsgid: 'e',
        root: expect.objectContaining({ id: ids.elsewhere, nick: 'dave', text: 'elsewhere' }),
        replies: 1,
        lastReplyId: ids.aside,
        lastReplyTime: expect.any(String),
      },
      {
        rootMsgid: 'q',
        root: expect.objectContaining({ id: ids.question, nick: 'alice' }),
        replies: 2,
        lastReplyId: ids['follow-up'],
        lastReplyTime: expect.any(String),
      },
    ]);
  });

  it('`thread-read` sends the new list', async () => {
    const read = await session(
      { type: 'thread-read', bufferId, rootMsgid: 'q', messageId: ids['follow-up'] },
      'threads-changed',
    );
    expect(read.after.find((f) => f.kind === 'threads-changed')?.threads).toMatchObject([
      { rootMsgid: 'q', unread: 0 },
    ]);
  });

  it('`mark-all-read` takes every followed thread to its newest reply too', async () => {
    const { insertMessage } = await import('../db/messages.js');
    const { followThread } = await import('../db/threadFollows.js');
    // A second thread the user is in, with a reply they haven't seen.
    insertMessage({
      networkId,
      target: CHANNEL,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: 'second question',
      msgid: 's',
    });
    insertMessage({
      networkId,
      target: CHANNEL,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'second answer',
      msgid: 's1',
      replyMsgid: 's',
      replyRootMsgid: 's',
    });
    followThread(userId, bufferId, 's', 0);
    const all = await session({ type: 'mark-all-read' }, 'threads-changed');
    const threads = all.after.find((f) => f.kind === 'threads-changed')?.threads as Array<{
      rootMsgid: string;
      unread: number;
    }>;
    expect(threads.find((t) => t.rootMsgid === 's')?.unread).toBe(0);
    expect(threads.every((t) => t.unread === 0)).toBe(true);
  });
});
