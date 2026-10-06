// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin → Notifications: the opt-in to push.lurker.chat for the official apps
// (lurker-dev/RELAY_PLAN.md §5a). Mounted under routes/admin.ts, so requireAuth +
// requireAdmin are inherited.
//
// The VAPID public key is here because it's what the admin registers with the
// relay when paying — /api/push/config has it too, but nobody should need
// devtools to find it.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPublicKey, vapidSubjectStatus } from '../services/pushService.js';
import { senderFor } from '../services/push/index.js';
import { PUSH_TRANSPORTS } from '../db/pushSubscriptions.js';
import { pushRelayEnabled } from '../db/instanceSettings.js';
import { RELAY_ORIGIN, relayDeviceCount, setRelayEnabled } from '../services/push/relay.js';

const router = Router();

function payload() {
  return {
    publicKey: getPublicKey(),
    vapidSubject: vapidSubjectStatus(),
    transports: PUSH_TRANSPORTS.filter((t) => senderFor(t).isConfigured()),
    relay: {
      url: RELAY_ORIGIN,
      enabled: pushRelayEnabled(),
      devices: relayDeviceCount(),
    },
  };
}

router.get('/', (_req: Request, res: Response) => {
  res.json(payload());
});

router.put('/relay', (req: Request, res: Response) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  const removed = setRelayEnabled(enabled);
  res.json({ ...payload(), removed });
});

export default router;
