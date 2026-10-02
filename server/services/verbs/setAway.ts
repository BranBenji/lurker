// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { singleLine } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_away',
  description:
    'Set or clear your away status on one network (`networkId`), or on every network when ' +
    '`networkId` is omitted (like /away -all). Provide `message` to mark yourself away with ' +
    'that reason; omit it or pass an empty string to come back. Returns { ok: true, away } ' +
    'reflecting the new state.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: {
        type: 'integer',
        description: 'The network to set away on. Omit for every network.',
      },
      message: {
        type: 'string',
        description: 'Away reason. Empty or omitted clears away (marks you back).',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    // callVerb has already refused a networkId the user doesn't own.
    const scope = input.networkId == null ? 'all' : Number(input.networkId);
    // A multi-line message is refused rather than flattened: the AWAY it becomes
    // goes to the network with any newline sent as a space
    // (IrcConnection.sendAwayState), which isn't what was asked.
    const parsed = singleLine(input.message, { malformed: 'message-must-be-single-line' });
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const message = parsed.value ?? '';
    if (message) ircManager.setAway(ctx.userId, scope, message, { autoSet: false });
    else ircManager.clearAway(ctx.userId, scope, { autoSet: false });
    return { ok: true, away: !!message };
  },
});
