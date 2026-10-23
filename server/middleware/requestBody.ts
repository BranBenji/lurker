// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { RequestHandler } from 'express';

// No compressed request bodies. body-parser pipes a `Content-Encoding: gzip`,
// `deflate` or `br` body through zlib by default, before any route or auth
// runs, handing an anonymous caller a decompressor to aim at (CVE-2026-111497
// was Node's Brotli decoder). Nothing that talks to Lurker compresses what it
// sends — browsers, URLSession and OkHttp don't — so a compressed body is a
// probe. Refused once, at the app's edge, ahead of every body reader there is
// or will be, rather than as an option each parser has to remember.
export const refuseCompressedBodies: RequestHandler = (req, res, next) => {
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
    res.status(415).json({ error: 'invalid_request' });
    return;
  }
  next();
};

// body-parser marks its own failures (malformed JSON or form data, a body over
// the limit, an unsupported charset) with a `type` such as 'entity.parse.failed'
// and a 4xx `status`. That is the client's mistake, not a server fault — and
// the parser attaches the raw body to the error, which can be a password or an
// OAuth code, so such an error is answered with its 4xx and never logged.
export function isBodyParseError(err: unknown): err is { status: number } {
  if (!err || typeof err !== 'object') return false;
  const { type, status } = err as { type?: unknown; status?: unknown };
  return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500;
}
