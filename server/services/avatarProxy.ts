// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The client-facing URL for an avatar another user set (IRCv3 metadata, #607).
// An avatar renders itself in the scroll, so it's an involuntary fetch and
// goes through the same proxy as a link-preview thumbnail: the byte-cache CDN
// URL when the image is already cached, else the authenticated media proxy
// (`/api/link-preview/media/<token>`, minted from the already-vetted URL). Null
// when the previews decoder isn't configured — the proxy route isn't mounted
// then, and Lurker never fetches an untrusted image in-process. The client
// shows its generated tile instead.
//
// Kept out of ircMetadata.ts so the pure helpers stay importable without a
// database (publicByteUrl reads the byte-cache index).

import { previewsEnabled } from '../utils/previews.js';
import { mintProxyToken } from './mediaProxyToken.js';
import { publicByteUrl } from './previewCache/publicUrl.js';

export function avatarClientUrl(origin: string): string | null {
  if (!previewsEnabled()) return null;
  try {
    return publicByteUrl(origin) ?? `/api/link-preview/media/${mintProxyToken(origin)}`;
  } catch {
    return null;
  }
}
