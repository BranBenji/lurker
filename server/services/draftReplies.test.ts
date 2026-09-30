// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A composer draft carries the reply it's being written as, so it follows the
// user to another device like the text does, and an up-arrow history entry
// keeps the reply it was sent with. What's asserted is what a client gets back:
// the draft and history rows, and the draft-updated change.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import db from '../db/index.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { ensureExists as ensureBuffer } from '../db/buffers.js';
import { insertMessage } from '../db/messages.js';
import { listForUser } from '../db/drafts.js';
import { addEntry, inputHistoryFields, listRecentEntries } from '../db/inputHistory.js';
import draftsService from './draftsService.js';

let userId: number;
let otherUserId: number;
let networkId: number;
let seq = 0;

beforeAll(() => {
  userId = createUser('draft-replies').id;
  otherUserId = createUser('draft-replies-other').id;
  networkId = createNetwork(userId, {
    name: 'net',
    host: 'irc.example',
    port: 6697,
    tls: true,
    nick: 'me',
  })!.id;
  for (const t of ['#a', '#b']) ensureBuffer(userId, networkId, t);
});

const changes: Record<string, unknown>[] = [];
const onChange = (e: Record<string, unknown>) => changes.push(e);
draftsService.on('change', onChange);
afterEach(() => {
  changes.length = 0;
  db.prepare('DELETE FROM user_drafts').run();
});

// A line someone said, stored with a msgid — what a Reply can name.
function said(
  target: string,
  nick = 'alice',
  extra: Partial<Parameters<typeof insertMessage>[0]> = {},
): number {
  return Number(
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick,
      text: `line ${++seq} from ${nick}`,
      msgid: `mid${seq}`,
      ...extra,
    }).id,
  );
}

const draftIn = (target: string) => listForUser(userId).find((d) => d.target === target);

describe('a draft’s reply', () => {
  it('is stored with the text and comes back resolved, to the snapshot and the change', () => {
    const line = said('#a');
    draftsService.set(userId, networkId, '#a', 'alice: noon', { messageId: line, addressed: true });
    expect(draftIn('#a')).toMatchObject({
      body: 'alice: noon',
      reply: {
        messageId: line,
        addressed: true,
        parent: { id: line, nick: 'alice', type: 'message', self: false },
      },
    });
    expect(changes.at(-1)).toMatchObject({
      body: 'alice: noon',
      reply: { messageId: line, addressed: true, parent: { nick: 'alice' } },
    });
  });

  // Reply on your own line or in a DM puts nothing in the text.
  it('is a draft on its own, with no text yet', () => {
    const line = said('#a');
    draftsService.set(userId, networkId, '#a', '', { messageId: line, addressed: false });
    expect(draftIn('#a')).toMatchObject({ body: '', reply: { messageId: line } });
    // Taken off with the text empty: nothing is left, so no draft.
    draftsService.set(userId, networkId, '#a', '', null);
    expect(draftIn('#a')).toBeUndefined();
    expect(changes.at(-1)).toMatchObject({ body: '', reply: null });
  });

  // A client that knows nothing of replies (luir; iOS until it does) edits the
  // text without saying anything about the reply: it stays.
  it('stays when a write says nothing about it, and goes when one clears it', () => {
    const line = said('#a');
    draftsService.set(userId, networkId, '#a', 'alice: no', { messageId: line, addressed: true });
    draftsService.set(userId, networkId, '#a', 'alice: noon', undefined);
    expect(draftIn('#a')?.reply?.messageId).toBe(line);
    draftsService.set(userId, networkId, '#a', 'alice: noon', null);
    expect(draftIn('#a')).toMatchObject({ body: 'alice: noon', reply: null });
    // Emptying the text from such a client clears the whole draft, as it did.
    draftsService.set(userId, networkId, '#a', 'x', { messageId: line, addressed: false });
    draftsService.set(userId, networkId, '#a', '', undefined);
    expect(draftIn('#a')).toBeUndefined();
  });

  // The server re-checks at send anyway; a draft never holds a reply it would
  // refuse there, and never tells another device about a line it can't see.
  it('is dropped when it names a line a reply here can’t', () => {
    const inB = said('#b');
    const noMsgid = said('#a', 'alice', { msgid: undefined });
    const theirs = createNetwork(otherUserId, {
      name: 'theirs',
      host: 'irc.example',
      port: 6697,
      tls: true,
      nick: 'them',
    })!.id;
    ensureBuffer(otherUserId, theirs, '#a');
    const notOurs = Number(
      insertMessage({
        networkId: theirs,
        target: '#a',
        time: new Date().toISOString(),
        type: 'message',
        nick: 'x',
        text: 'private',
        msgid: 'theirs1',
      }).id,
    );
    for (const messageId of [inB, noMsgid, notOurs, 999999]) {
      draftsService.set(userId, networkId, '#a', 'hi', { messageId, addressed: true });
      expect(draftIn('#a')).toMatchObject({ body: 'hi', reply: null });
    }
    // With no text either, nothing is left.
    draftsService.set(userId, networkId, '#a', '', { messageId: inB, addressed: false });
    expect(draftIn('#a')).toBeUndefined();
  });

  // The sending tab still shows the reply it sent. Kept, it needn't hear back
  // (it has it); dropped, it must, or it goes on showing one the draft lacks.
  it('tells the sender too when the reply it sent was dropped', () => {
    const ws = { tab: 'sender' };
    const ignored = said('#a', 'mallory', { fromIgnored: true });
    draftsService.set(userId, networkId, '#a', 'hm', { messageId: ignored, addressed: false }, ws);
    expect(changes.at(-1)).toMatchObject({ body: 'hm', reply: null, originWs: null });
    draftsService.set(userId, networkId, '#a', '', { messageId: ignored, addressed: false }, ws);
    expect(changes.at(-1)).toMatchObject({ body: '', reply: null, originWs: null });
    const line = said('#a');
    draftsService.set(userId, networkId, '#a', 'ok', { messageId: line, addressed: false }, ws);
    expect(changes.at(-1)).toMatchObject({ reply: { messageId: line }, originWs: ws });
  });

  // Retention took the line, or its author is ignored since: the text stays,
  // the reply reads as gone, as a reply's quote reads unavailable.
  it('reads as gone once the line is, and the text stays', () => {
    const line = said('#a');
    draftsService.set(userId, networkId, '#a', 'alice: noon', { messageId: line, addressed: true });
    db.prepare('DELETE FROM messages WHERE id = ?').run(line);
    expect(draftIn('#a')).toMatchObject({ body: 'alice: noon', reply: null });

    const ignored = said('#a', 'mallory', { fromIgnored: true });
    draftsService.set(userId, networkId, '#a', 'hm', { messageId: ignored, addressed: false });
    expect(draftIn('#a')?.reply).toBeNull();
  });
});

describe('an input-history entry’s reply', () => {
  it('is kept with the line it was sent as, and rides beside inputHistory', () => {
    const line = said('#b');
    addEntry(userId, networkId, '#b', '/join #x');
    addEntry(userId, networkId, '#b', 'alice: noon', { messageId: line, addressed: true });
    addEntry(userId, networkId, '#b', 'plain');
    expect(listRecentEntries(userId, networkId, '#b').map((e) => e.reply?.messageId)).toEqual([
      undefined,
      line,
      undefined,
    ]);
    const fields = inputHistoryFields(userId, networkId, '#b', 200);
    expect(fields.inputHistory).toEqual(['/join #x', 'alice: noon', 'plain']);
    expect(fields.inputHistoryReplies?.map((r) => r?.parent.nick ?? null)).toEqual([
      null,
      'alice',
      null,
    ]);
  });

  it('adds nothing to the frame when no entry has one, or names a line it can’t', () => {
    addEntry(userId, networkId, '#a', 'first');
    addEntry(userId, networkId, '#a', 'second', { messageId: said('#b'), addressed: false });
    expect(inputHistoryFields(userId, networkId, '#a', 200)).toEqual({
      inputHistory: ['first', 'second'],
    });
  });
});
