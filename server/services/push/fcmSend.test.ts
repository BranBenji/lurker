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
function stubFetch(rejection: unknown, status = 400) {
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url: string) =>
    url.includes('oauth2')
      ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
      : new Response(JSON.stringify(rejection), { status }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function verdictFor(rejection: unknown, status = 400): Promise<string> {
  stubFetch(rejection, status);
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

// FCM's own code rides in `details` as an FcmError; `error.status` is only the
// gRPC status (firebase.google.com/docs/cloud-messaging/error-codes).
const fcmError = (code: number, status: string, errorCode?: string) => ({
  error: {
    code,
    message: 'x',
    status,
    ...(errorCode
      ? { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] }
      : {}),
  },
});

describe("fcm send reads FCM's error code, not just the status", () => {
  it('deletes an unregistered device', async () => {
    expect(await verdictFor(fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), 404)).toBe('permanent');
  });

  it('deletes a token from another Firebase project, though it arrives as a 403', async () => {
    expect(await verdictFor(fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'), 403)).toBe(
      'permanent',
    );
  });

  it('keeps the access token when a 403 is about the device, not us', async () => {
    const fetch = stubFetch(fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'), 403);
    const oauthCalls = () =>
      fetch.mock.calls.filter(([url]) => String(url).includes('oauth2')).length;
    const failOnce = async () => {
      const err = await fcmSender.send(sub, payload, composeNotification(payload)).catch((e) => e);
      fcmSender.onFailure?.(err, fcmSender.classify(err));
    };
    await failOnce(); // warms the token cache, whatever state it was in
    const before = oauthCalls();
    await failOnce();
    await failOnce();
    expect(oauthCalls()).toBe(before);
  });

  it("doesn't delete devices over a 404 that isn't UNREGISTERED (our project id)", async () => {
    expect(await verdictFor(fcmError(404, 'NOT_FOUND'), 404)).toBe('transient');
  });
});
