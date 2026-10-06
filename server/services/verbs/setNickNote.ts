// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { fanOutToUser } from '../wsHub.js';
import { capText } from '../../utils/capText.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_nick_note',
  description:
    'Write a free-form note about a nick on a network. Pass an empty string to clear the note. Notes are capped at 4096 chars.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string' },
      note: {
        type: 'string',
        description: 'The note body. Empty/whitespace string deletes the note.',
        maxLength: 4096,
      },
    },
    required: ['networkId', 'nick', 'note'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const nick = typeof input.nick === 'string' ? input.nick.trim() : '';
    if (!nick) {
      throw Object.assign(new Error('nick is empty or whitespace'), { code: 'invalid_input' });
    }
    const raw = typeof input.note === 'string' ? input.note : '';
    const note = capText(raw, 4096);
    const saved = ircManager.setNickNote(ctx.userId, networkId, nick, note);
    const result = {
      networkId,
      nick,
      note: saved ? saved.note : '',
      updatedAt: saved ? saved.updatedAt : null,
    };
    // Fan out to every open WS tab of this user — both transports converge on
    // the same `nick-note-updated` event so the UI reacts identically whether
    // the change came from the browser or an agent.
    fanOutToUser(ctx.userId, { kind: 'nick-note-updated', ...result });
    return result;
  },
});
