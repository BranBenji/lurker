// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The client-facing URL for an avatar another user set (IRCv3 metadata, #607).
// An avatar renders itself in the scroll, so it's an involuntary fetch and
// goes through the previews decoder like a link-preview thumbnail, resized
// and cropped there (lurker#1190): the byte-cache CDN URL when that avatar is
// already cached, else the authenticated avatar route
// (`/api/link-preview/avatar/<token>`, minted from the already-vetted URL). Null
// when the previews decoder isn't configured — the proxy route isn't mounted
// then, and Lurker never fetches an untrusted image in-process. The client
// shows its generated tile instead.
//
// Kept out of ircMetadata.ts so the pure helpers stay importable without a
// database (publicObjectUrl reads the byte-cache index).

import { previewsEnabled } from '../utils/previews.js';
import { mintAvatarToken } from './mediaProxyToken.js';
import { avatarCacheKey } from './previewCache/config.js';
import { publicObjectUrl } from './previewCache/publicUrl.js';

export function avatarClientUrl(origin: string): string | null {
  if (!previewsEnabled()) return null;
  try {
    return (
      publicObjectUrl(avatarCacheKey(origin)) ??
      `/api/link-preview/avatar/${mintAvatarToken(origin)}`
    );
  } catch {
    return null;
  }
}
