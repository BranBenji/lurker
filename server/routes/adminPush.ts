// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin → Notifications: the opt-in to push.lurker.chat for the official apps
// (lurker-dev/RELAY_PLAN.md §5a). Mounted under routes/admin.ts, so requireAuth +
// requireAdmin are inherited.
//
// The VAPID public key is here because it's what the admin registers with the
// relay when paying — /api/push/config has it too, but nobody should need
// devtools to find it.
//
// The relay's status (§6.5) is only fetched once the admin has opted in, or when
// they ask with "check": until then this server doesn't contact the relay at all.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPublicKey, vapidSubjectStatus } from '../services/pushService.js';
import { senderFor } from '../services/push/index.js';
import { PUSH_TRANSPORTS } from '../db/pushSubscriptions.js';
import { pushRelayEnabled } from '../db/instanceSettings.js';
import { RELAY_ORIGIN, relayDeviceCount, setRelayEnabled } from '../services/push/relay.js';
import { relayStatus, type RelayStatus } from '../services/push/relayStatus.js';

const router = Router();

function payload(status: RelayStatus | null) {
  return {
    publicKey: getPublicKey(),
    vapidSubject: vapidSubjectStatus(),
    transports: PUSH_TRANSPORTS.filter((t) => senderFor(t).isConfigured()),
    relay: {
      url: RELAY_ORIGIN,
      enabled: pushRelayEnabled(),
      devices: relayDeviceCount(),
      status,
    },
  };
}

// What turning the relay on is refused with, by what the relay said.
function refusal(status: RelayStatus): string | null {
  switch (status.state) {
    case 'active':
      return null;
    case 'inactive':
      return status.registered
        ? "This server's key isn't active on push.lurker.chat."
        : "push.lurker.chat doesn't recognize this server's key.";
    case 'unauthorized':
      return "push.lurker.chat couldn't verify this server's key.";
    case 'unreachable':
      return "Couldn't reach push.lurker.chat.";
  }
}

// Express 5 passes a rejected handler promise to the error handler.
router.get('/', async (_req: Request, res: Response) => {
  // Cached: a pane load shouldn't ask the relay every time.
  const status = pushRelayEnabled() ? await relayStatus() : null;
  res.json(payload(status));
});

// The admin asking, before turning the relay on (or any time after).
router.post('/relay/check', async (_req: Request, res: Response) => {
  res.json(payload(await relayStatus({ fresh: true })));
});

router.put('/relay', async (req: Request, res: Response) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  // Turning on asks the relay first: with the key not active there, every push
  // would be refused and count against the devices. Turning off never asks, and
  // a failed check never switches an enabled relay off.
  let status: RelayStatus | null = null;
  if (enabled) {
    status = await relayStatus({ fresh: true });
    const why = refusal(status);
    if (why) {
      res.status(409).json({ error: why, ...payload(status) });
      return;
    }
  }
  const removed = setRelayEnabled(enabled);
  res.json({ ...payload(status), removed });
});

export default router;
