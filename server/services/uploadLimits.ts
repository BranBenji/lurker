// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// THE upload size cap, in one place (#627).
//
// Three ceilings stack, and a client that wants to size media to fit needs the
// smallest of them — not any single one:
//
//   1. uploadCeilingBytes the instance ceiling (#1131): what the admin set on
//                        Admin → Uploaders, or the operator's
//                        LURKER_NODE_UPLOAD_MAX_MB on a hosted cell; 200 MB until
//                        someone raises it. Nothing may exceed it, and there is
//                        no larger bound in code: the disk is the bound, and an
//                        upload session refuses what would breach the free-disk
//                        floor.
//   2. transportCapBytes the request-body limit of whatever sits IN FRONT of this
//                        instance. app.lurker.chat is behind Cloudflare, whose
//                        limit is 100 MB on Free/Pro (200 MB on Business); a
//                        larger body dies at the edge with a connection reset the
//                        client sees as an unparseable response, before Express is
//                        ever reached. The server cannot detect this, so the
//                        operator declares it via LURKER_MAX_UPLOAD_MB.
//   3. the per-user cap  the operator-baked uploader policy (hosted locked row),
//                        else the user's own `uploads.image.max_upload_mb`.
//
// Every path that enforces or advertises a size cap goes through here, so
// multer's limit, the handler's 413, and the number we hand clients can never
// disagree. `POST /api/imports` keeps its own much larger limit (an archive isn't
// something a client sizes media against) but borrows the transport ceiling via
// clampToTransport — see #649.
//
// Bytes, not MB, is the canonical unit: it's what multer takes, what a client
// compares a file size against, and the only unit in which the transport
// ceiling's headroom below can be expressed honestly.

import { getUserSettings } from '../db/settings.js';
import { uploadCeilingMbStandalone } from '../db/instanceSettings.js';
import { isNodeMode } from '../utils/edition.js';
import { defaultsAsObject, getOption } from './settingsRegistry.js';
import { nodeUploadLimits } from './uploadProviders/nodeUpload.js';
import { resolveUploader, type UploaderPolicy } from './uploadProviders/resolve.js';

const MIB = 1024 * 1024;

/** The largest archive `POST /api/imports` or an import session takes. 500 MB is
 *  generous for "a single user's logs"; if a user trips this we want to see the
 *  report rather than silently accept something unbounded. The archive streams
 *  to a temp file and the importer reads it from disk, so memory stays flat. */
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

/**
 * The instance ceiling in MiB (#1131). On a hosted cell it is the operator's
 * env, read fresh each time like the rest of the node pipeline knobs; on a
 * self-host it is what the admin stored, else the install default. Read on every
 * call rather than cached: the admin's PUT takes effect on the next upload, and
 * the read is one indexed row.
 */
export function uploadCeilingMb(): number {
  return isNodeMode() ? nodeUploadLimits().maxMb : uploadCeilingMbStandalone();
}

/** The same ceiling in bytes — the unit everything below compares in. */
export function uploadCeilingBytes(): number {
  return uploadCeilingMb() * MIB;
}

// What the multipart envelope costs on top of the file itself: the boundary
// lines, each part's Content-Disposition/Content-Type headers, and the
// `uploaderId` / `progressToken` text fields. A proxy limit applies to the whole
// REQUEST BODY, but multer's fileSize limit — and the number we advertise —
// describe the FILE part alone, so the difference has to come off the top.
// Without it a client that does exactly what the docs tell it (compress to
// maxUploadBytes) ships a body just over the proxy's limit and gets the edge
// reset this whole feature exists to prevent. 64 KiB is far more than the few
// hundred bytes actually needed; the slack is free and covers future fields.
const ENVELOPE_HEADROOM_BYTES = 64 * 1024;

/** Resolve effective settings with registry defaults filled in. The per-user
 *  image-pipeline settings (size cap, max dimension, JPEG quality) are the
 *  fallback used when the resolved uploader carries no operator-baked policy caps
 *  — i.e. every self-host uploader. Untyped (JS module) → Record<string, unknown>. */
export function effectiveSettings(userId: number): Record<string, unknown> {
  return { ...defaultsAsObject(), ...getUserSettings(userId) };
}

/** The user's size cap, in bytes. 0 — the registry default — and anything
 *  unusable mean "the instance ceiling": an account that never set its own cap
 *  follows the ceiling, so raising it raises them all at once (#1131). MiB,
 *  matching the registry setting's own units. Not clamped here; every caller
 *  clamps to the ceiling after choosing between this and a policy cap. */
export function userCapBytes(settings: Record<string, unknown>): number {
  const n = Number(settings['uploads.image.max_upload_mb']);
  return Number.isFinite(n) && n > 0 ? n * MIB : uploadCeilingBytes();
}

// Warn once per process, not per upload: transportCapBytes() runs on every
// snapshot and every upload, and a misconfiguration that repeats a thousand
// times a minute is noise rather than a signal.
let warnedBadTransportCap = false;

/**
 * What the operator DECLARED, in bytes, or null when they declared nothing —
 * the self-hoster with no proxy in front of them. Not clamped to any upload
 * ceiling: a caller with its own, larger limit (`POST /api/imports` allows
 * 500 MB) needs the raw declaration, and would silently lose headroom if
 * "unset" were reported as the upload path's ceiling.
 *
 * Deliberately an env var rather than a tenant setting, for the same reason the
 * node-edition pipeline knobs are: it describes the deployment, not a preference,
 * and a tenant must not be able to raise it.
 *
 * The declared MB is read as DECIMAL (10⁶), unlike the per-user setting's MiB.
 * Proxies disagree — Cloudflare documents decimal MB, nginx's `client_max_body_size
 * 100m` is 100 MiB — and the decimal reading is the smaller of the two, so it is
 * the safe one when the proxy's own unit is unknown. Erring 4.8% low costs a
 * self-hoster nothing; erring high is the edge reset again.
 */
export function declaredTransportCapBytes(): number | null {
  const raw = (process.env.LURKER_MAX_UPLOAD_MB || '').trim();
  if (!raw) return null;
  const mb = Math.floor(Number(raw));
  if (!Number.isFinite(mb) || mb <= 0) {
    // "100MB" / "100m" — the natural typo, given the var is named _MB — parses to
    // NaN. Falling back to no-ceiling is the right direction (a typo must never
    // refuse every upload on the instance), but silently doing so would leave the
    // operator looking at a setting that never took effect while uploads keep
    // dying at the edge. Say so.
    if (!warnedBadTransportCap) {
      warnedBadTransportCap = true;
      console.warn(
        `[lurker] LURKER_MAX_UPLOAD_MB="${raw}" is not a positive whole number of ` +
          'megabytes; ignoring it. Uploads are NOT bounded by a transport ceiling. ' +
          'Use a bare integer, e.g. LURKER_MAX_UPLOAD_MB=100.',
      );
    }
    return null;
  }
  return mb * 1_000_000 - ENVELOPE_HEADROOM_BYTES;
}

/** The transport ceiling as the UPLOAD path sees it: the declaration, else no
 *  extra ceiling beyond the instance ceiling. A declaration can only LOWER the
 *  cap — a proxy that passes more than the ceiling doesn't raise it. */
export function transportCapBytes(): number {
  const ceiling = uploadCeilingBytes();
  return Math.min(declaredTransportCapBytes() ?? ceiling, ceiling);
}

/**
 * Apply the transport ceiling to a caller that has its OWN limit — currently the
 * import route's 500 MB. Nothing here involves the upload hard cap or a user's
 * preference; it answers only "can a body this big reach us at all".
 */
export function clampToTransport(ownLimitBytes: number): number {
  const declared = declaredTransportCapBytes();
  return declared == null ? ownLimitBytes : Math.max(1, Math.min(ownLimitBytes, declared));
}

// A chunked upload (#650) sends the file a piece per request, so no proxy limit
// caps the file; the transport ceiling caps the CHUNK instead. 16 MiB keeps a
// dropped connection's loss small, and a GB-sized file to a few dozen requests.
const UPLOAD_CHUNK_MAX_BYTES = 16 * 1024 * 1024;
let chunkBytesOverride: number | null = null;

/** The largest chunk a session takes: 16 MiB, or less behind a proxy that
 *  declared a smaller body limit. */
export function uploadChunkBytes(): number {
  const max = chunkBytesOverride ?? UPLOAD_CHUNK_MAX_BYTES;
  const declared = declaredTransportCapBytes();
  return Math.max(1, declared == null ? max : Math.min(max, declared));
}

/** Tests send files of a few bytes in chunks of a few bytes. */
export function setUploadChunkBytesForTests(bytes: number | null): void {
  chunkBytesOverride = bytes;
}

/** Clamp a candidate cap to the instance-wide ceilings. Floors at 1 byte so no
 *  configuration can resolve to a negative or zero cap; a genuinely tiny value is
 *  the operator's own declaration and is reported honestly rather than rounded up
 *  past the limit they set. Whole bytes: this is multer's fileSize, and multer
 *  (2.4+) THROWS on a fractional limit when it's constructed — per request, so a
 *  fractional policy maxMb would 500 every upload. Before that, busboy just
 *  ignored one. */
export function clampUploadCapBytes(bytes: number): number {
  // transportCapBytes() is already under the instance ceiling.
  return Math.max(1, Math.floor(Math.min(bytes, transportCapBytes())));
}

/** The policy of the user's DEFAULT uploader, or null when none is usable. An
 *  unusable uploader is not an error here: "how big may I upload" has an answer
 *  even when the answer to "where does it go" is currently 400/503 — falling back
 *  to the user's own settings keeps this from being a second failure surface. */
function defaultUploaderPolicy(userId: number, isAdmin: boolean): UploaderPolicy | null {
  try {
    return resolveUploader({ userId, isAdmin, requestedId: null }).policy;
  } catch {
    return null;
  }
}

/** The cap for a resolved uploader's policy and the user's effective settings: the
 *  operator-baked policy wins, else the user's own setting, clamped to the instance
 *  ceilings. The handler's 413 (the actually-resolved uploader) and the advertised
 *  number (the default one) both come through here. */
export function capBytesFor(
  policy: Pick<UploaderPolicy, 'maxMb'> | null,
  settings: Record<string, unknown>,
): number {
  return clampUploadCapBytes(chunkedCapBytesFor(policy, settings));
}

/** The same cap for a chunked upload (#650), which no transport ceiling
 *  touches: the policy or the user's setting, under the instance ceiling. */
export function chunkedCapBytesFor(
  policy: Pick<UploaderPolicy, 'maxMb'> | null,
  settings: Record<string, unknown>,
): number {
  const policyMb = policy?.maxMb;
  const bytes = policyMb == null ? userCapBytes(settings) : policyMb * MIB;
  return Math.max(1, Math.floor(Math.min(bytes, uploadCeilingBytes())));
}

/**
 * The effective cap for this user, in bytes — what a client should size media to
 * fit and what the server will actually accept. Resolves the user's DEFAULT
 * uploader: a per-upload `uploaderId` override with a tighter policy cap is caught
 * by the handler's own re-check, which is the number that ends up in the 413.
 */
export function effectiveUploadCapBytes(userId: number, isAdmin: boolean): number {
  return capBytesFor(defaultUploaderPolicy(userId, isAdmin), effectiveSettings(userId));
}

/**
 * The longest edge, in pixels, the pipeline keeps of a STATIC image (#872) — the
 * `maxDim` it hands sharp. The operator-baked policy wins (a hosted cell fills it
 * from LURKER_NODE_UPLOAD_MAX_DIM), else the user's own setting. This is the ONE
 * resolution of that number: the upload pipeline enforces it and the advertised
 * `maxStaticImageDimension` reports it, so the two can't disagree the way a client
 * reading the raw setting would (on a cell the tenant's value is ignored).
 *
 * Static only. Animated GIF/WebP/APNG bypass the resize and go up verbatim, and SVG
 * is a vector passed through as-is — a client that shrank those would destroy them.
 */
export function staticImageMaxDimension(
  policy: Pick<UploaderPolicy, 'maxDim'> | null,
  settings: Record<string, unknown>,
): number {
  // Whole positive pixels or nothing: sharp rejects a resize to 0 or a fraction, and
  // a client told 0 would be asked for an image with no pixels. The seed clamps the
  // policy value, but resolve.ts accepts any finite number from the config row.
  const usable = (v: unknown): number | null => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // effectiveSettings() has already merged the registry default in; the last
  // fallback only covers a stored value that isn't usable, and reads the same
  // registry default rather than repeating it.
  return (
    usable(policy?.maxDim) ??
    usable(settings['uploads.image.max_dimension']) ??
    (getOption('uploads.image.max_dimension')?.default as number)
  );
}

export interface AdvertisedUploadLimits {
  maxUploadBytes: number;
  maxStaticImageDimension: number;
  /** The largest file a chunked upload session takes (#650). */
  maxChunkedUploadBytes: number;
  /** The largest chunk a session takes (#650). */
  uploadChunkBytes: number;
  /** The instance ceiling (#1131): the most any account on this server may be
   *  allowed, and the bound on the user's own cap setting. */
  uploadCeilingBytes: number;
}

/**
 * The numbers a client sizes an upload against, resolved for the user's DEFAULT
 * uploader in one pass — the snapshot and `GET /api/uploads` carry exactly this.
 * Advisory, like the cap alone: a per-upload `uploaderId` override with a
 * different policy is still settled server-side. The two err differently under an
 * override, though. Compressing to the default's cap only costs bandwidth, but an
 * override may keep MORE pixels than the default's dimension, and pixels a client
 * shrank away can't be recovered — so a client sending an override should upload
 * images as-is (CLIENT_PROTOCOL.md says so).
 */
export function advertisedUploadLimits(userId: number, isAdmin: boolean): AdvertisedUploadLimits {
  const policy = defaultUploaderPolicy(userId, isAdmin);
  const settings = effectiveSettings(userId);
  return {
    maxUploadBytes: capBytesFor(policy, settings),
    maxStaticImageDimension: staticImageMaxDimension(policy, settings),
    maxChunkedUploadBytes: chunkedCapBytesFor(policy, settings),
    uploadChunkBytes: uploadChunkBytes(),
    uploadCeilingBytes: uploadCeilingBytes(),
  };
}

/** The cap as a human-readable MB string for the 413 body. At most one decimal,
 *  because the transport ceiling's headroom makes a whole number a lie: telling a
 *  user their file "exceeds 1 MB" when the real limit is 0.9 MB sends them back
 *  with another file that fails. */
export function formatCapMb(bytes: number): string {
  const mb = bytes / MIB;
  return (mb >= 10 ? Math.floor(mb) : Math.floor(mb * 10) / 10).toString();
}
