// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What send() reads off an FCM rejection, fed Google's own error bodies.
//
// INVALID_ARGUMENT is both "this token is garbage" (the device's fault — delete
// it) and "this message is over 4 KB / uses a reserved key" (ours — identical for
// every device). classify() can only tell them apart if send() carried the
// difference out of the response body, so that is the part pinned here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { fcmSender } from './fcmSender.js';
import { resetCredentialCache } from './credentials.js';
import type { PushSubscription } from '../../db/pushSubscriptions.js';
import { composeNotification, type PushPayload } from '../notificationContent.js';

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const sub: PushSubscription = {
  id: 1,
  user_id: 1,
  endpoint: 'fcmtoken',
  transport: 'fcm',
  p256dh: null,
  auth: null,
  user_agent: null,
  enabled: true,
  created_at: '',
  last_seen_at: '',
  fail_count: 0,
};

const payload: PushPayload = {
  kind: 'dm',
  networkId: 7,
  networkName: 'Libera',
  target: 'bob',
  nick: 'bob',
  text: 'hey',
};

// The OAuth exchange answers first, then the send answers with `rejection`.
function stubFetch(rejection: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('oauth2')
        ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
        : new Response(JSON.stringify(rejection), { status: 400 }),
    ),
  );
}

async function verdictFor(rejection: unknown): Promise<string> {
  stubFetch(rejection);
  const err = await fcmSender.send(sub, payload, composeNotification(payload)).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).not.toBeNull();
  return fcmSender.classify(err);
}

beforeEach(() => {
  process.env.LURKER_FCM_SERVICE_ACCOUNT = JSON.stringify({
    project_id: 'lurker-test',
    client_email: 'push@lurker-test.iam.gserviceaccount.com',
    private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  resetCredentialCache();
});

afterEach(() => {
  delete process.env.LURKER_FCM_SERVICE_ACCOUNT;
  resetCredentialCache();
  vi.unstubAllGlobals();
});

describe('fcm send reads INVALID_ARGUMENT', () => {
  it('deletes a device whose token Google names as invalid', async () => {
    // Captured from live FCM v1 on 2026-10-05, answering a send to a made-up
    // token. It carries BOTH signals namesTheToken reads.
    const verdict = await verdictFor({
      error: {
        code: 400,
        message: 'The registration token is not a valid FCM registration token',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
            errorCode: 'INVALID_ARGUMENT',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [
              {
                field: 'message.token',
                description: 'The registration token is not a valid FCM registration token',
              },
            ],
          },
        ],
      },
    });
    expect(verdict).toBe('permanent');
  });

  it('deletes a device on the message wording alone', async () => {
    // The body Firebase's error-codes page documents: no field violation.
    const verdict = await verdictFor({
      error: {
        code: 400,
        message: 'The registration token is not a valid FCM registration token',
        status: 'INVALID_ARGUMENT',
      },
    });
    expect(verdict).toBe('permanent');
  });

  it('deletes a device when the field violation is on message.token', async () => {
    const verdict = await verdictFor({
      error: {
        code: 400,
        message: 'Invalid value',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [{ field: 'message.token', description: 'Invalid' }],
          },
        ],
      },
    });
    expect(verdict).toBe('permanent');
  });

  it('only strikes when the message itself is what Google rejected', async () => {
    const verdicts = [];
    for (const message of ['Message is too big', 'Invalid data payload key: from']) {
      verdicts.push(
        await verdictFor({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } }),
      );
    }
    expect(verdicts).toEqual(['strike', 'strike']);
  });
});
