// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// In the hosted (node) edition the cell never lets a tenant choose an upload
// host: every upload goes through the operator-run in-house dropper — the same
// R2-backed Hoarder service the `hoarder` provider already speaks to — using
// operator-supplied credentials from the environment rather than per-user
// settings. A tenant must never see or set these keys. This module centralizes
// the env var names + secret lookup so the upload route and the boot-time
// config check agree, and keeps it out of the (mockable) provider registry so
// the route reads the real environment in tests.

import { DEFAULT_UPLOAD_CEILING_MB } from '../../../shared/settingsRegistry.js';
import { getOption } from '../settingsRegistry.js';

/** Provider id forced for every upload in node edition. */
export const NODE_UPLOAD_PROVIDER_ID = 'dropper';

/**
 * Operator-supplied in-house uploader credentials, read fresh from the
 * environment (operator config is fixed for the process lifetime; reading on
 * demand keeps this trivially testable). Shaped to match what the hoarder
 * provider's `upload()` expects.
 */
export function nodeUploadSecrets(): { url: string; api_key: string } {
  return {
    url: (process.env.LURKER_NODE_UPLOAD_URL || '').trim(),
    api_key: (process.env.LURKER_NODE_UPLOAD_API_KEY || '').trim(),
  };
}

/** True only when both required env vars are present (drives the boot warning). */
export function nodeUploadConfigured(): boolean {
  const { url, api_key } = nodeUploadSecrets();
  return Boolean(url && api_key);
}

// Read an operator-set integer override for a registry int setting: clamped to
// that setting's [min,max] and falling back to its registry default when unset
// or malformed. Operator env is trusted, but clamping stops a typo'd value from
// breaking every upload on the cell.
function intOverride(envName: string, settingKey: string): number {
  const opt = getOption(settingKey);
  const fallback = opt && typeof opt.default === 'number' ? opt.default : 0;
  const raw = (process.env[envName] || '').trim();
  const n = raw ? Math.floor(Number(raw)) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const min = opt?.type === 'int' ? opt.min : n;
  const max = opt?.type === 'int' && typeof opt.max === 'number' ? opt.max : n;
  return Math.min(Math.max(n, min), max);
}

// The upload ceiling is NOT a registry override (#1131): the registry setting
// has no `max` any more, and its default (0, "the ceiling") is the one value
// that must never become the cell's cap. The env var IS the ceiling on a cell,
// unclamped — the operator raises hosted uploads by raising it (and the
// dropper's own cap, tracked in the control plane). Unset or malformed falls
// back to the install default, never to 0.
function ceilingOverride(envName: string): number {
  const raw = (process.env[envName] || '').trim();
  const n = raw ? Math.floor(Number(raw)) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_UPLOAD_CEILING_MB;
}

/**
 * Operator-controlled image-pipeline limits for node edition. In the hosted
 * service these are NOT tenant settings — a tenant could otherwise inflate
 * storage/bandwidth or lift their own size cap with a direct settings write —
 * so the cell sources them from the environment: the dimension and quality
 * clamped to each setting's registry [min,max] bounds and falling back to the
 * registry default, the size cap unclamped (it IS the cell's upload ceiling,
 * #1131) and falling back to the install default. A3 hides the matching tenant
 * UI; this is the enforcement behind it.
 */
export function nodeUploadLimits(): { maxMb: number; maxDim: number; quality: number } {
  return {
    maxMb: ceilingOverride('LURKER_NODE_UPLOAD_MAX_MB'),
    maxDim: intOverride('LURKER_NODE_UPLOAD_MAX_DIM', 'uploads.image.max_dimension'),
    quality: intOverride('LURKER_NODE_UPLOAD_QUALITY', 'uploads.image.quality'),
  };
}
