// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

setupTestDb('services-upload-limits');

const MIB = 1024 * 1024;
const ENVELOPE = 64 * 1024;

let user: User;
let fresh: User;
let setUserSetting: (userId: number, key: string, value: unknown) => void;
let limits: typeof import('./uploadLimits.js');
let instanceSettings: typeof import('../db/instanceSettings.js');
let db: typeof import('../db/index.js').default;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ setUserSetting } = await import('../db/settings.js'));
  limits = await import('./uploadLimits.js');
  instanceSettings = await import('../db/instanceSettings.js');
  db = (await import('../db/index.js')).default;
  user = createUser('alice');
  fresh = createUser('root');
});

afterEach(() => {
  delete process.env.LURKER_MAX_UPLOAD_MB;
  // Back to "the admin never set one", which is not the same row as "set to 200".
  db.prepare('DELETE FROM instance_settings WHERE key = ?').run(
    instanceSettings.UPLOAD_CEILING_MB_KEY,
  );
  vi.restoreAllMocks();
});

describe('transportCapBytes', () => {
  it('is the instance ceiling when unset — a self-hoster with nothing in front of them', () => {
    expect(limits.transportCapBytes()).toBe(limits.uploadCeilingBytes());
  });

  // The bug this feature exists to kill: a proxy limit applies to the whole
  // request body, so advertising it as a FILE size sends the client back with a
  // body just over the line. The envelope has to come off the top.
  it('reserves multipart headroom, so a file at the cap still fits in the body', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    const cap = limits.transportCapBytes();
    expect(cap).toBe(100 * 1_000_000 - ENVELOPE);
    expect(cap).toBeLessThan(100 * 1_000_000);
  });

  // Cloudflare documents decimal MB; nginx's client_max_body_size 100m is MiB.
  // Decimal is the smaller reading, so it's the safe one when the proxy is unknown.
  it('reads the declared MB as decimal, never as the larger MiB', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.transportCapBytes()).toBeLessThan(100 * MIB);
  });

  it('can never RAISE the instance ceiling', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '5000';
    expect(limits.transportCapBytes()).toBe(limits.uploadCeilingBytes());
  });

  // Silently ignoring "100MB" — the natural typo, given the var is named _MB —
  // leaves the operator staring at a setting that never took while uploads keep
  // dying at the edge. The fallback is right; the silence isn't.
  //
  // FIRST in this describe on purpose: the warning is latched once per process,
  // so any earlier test that trips an unparseable value consumes it.
  it('warns about an unparseable value instead of ignoring it silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.LURKER_MAX_UPLOAD_MB = '100MB';
    expect(limits.transportCapBytes()).toBe(limits.uploadCeilingBytes());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('LURKER_MAX_UPLOAD_MB'));
    // Once per process, not once per upload — this runs on every snapshot.
    limits.transportCapBytes();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats garbage and non-positive values as unset, never as "refuse everything"', () => {
    // A typo would otherwise take every upload on the instance down, which is a
    // much worse failure than ignoring the value.
    for (const raw of ['', '  ', 'lots', '0', '-10', 'NaN']) {
      process.env.LURKER_MAX_UPLOAD_MB = raw;
      expect(limits.transportCapBytes()).toBe(limits.uploadCeilingBytes());
    }
  });

  it('floors a fractional value rather than rounding up past the proxy limit', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '99.9';
    expect(limits.transportCapBytes()).toBe(99 * 1_000_000 - ENVELOPE);
  });
});

describe('effectiveUploadCapBytes', () => {
  it("defaults to the user's own setting, in MiB", () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 150);
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(150 * MIB);
  });

  it('is the SMALLEST of the ceilings — the transport limit wins when it is lower', () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 150);
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(100 * 1_000_000 - ENVELOPE);
  });

  it("does not inflate a user's lower cap up to the transport limit", () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 25);
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(25 * MIB);
  });

  it('is the instance ceiling for a user with no settings row at all', () => {
    // "How big may I upload" must have an answer before the user has touched a
    // single setting — this is the value a fresh client is told on connect. And
    // the answer is the ceiling, not a second default (#1131): an account that
    // never set its own cap follows whatever the admin allows.
    expect(limits.effectiveUploadCapBytes(fresh.id, true)).toBe(limits.uploadCeilingBytes());
  });
});

// #1131: the ceiling is the admin's, not a constant. 200 MB until raised, so an
// install that never touches it sees the old hard cap; no upper bound in code.
describe('the instance ceiling', () => {
  it('is 200 MiB until the admin sets one', () => {
    expect(limits.uploadCeilingMb()).toBe(200);
    expect(limits.uploadCeilingBytes()).toBe(200 * MIB);
  });

  it('raising it raises every account that never set its own cap, 0 included', () => {
    instanceSettings.setUploadCeilingMb(300);
    expect(limits.effectiveUploadCapBytes(fresh.id, true)).toBe(300 * MIB);
    // 0 is the registry default — "the ceiling" — not a 0-byte cap.
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 0);
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(300 * MIB);
  });

  it('keeps a LOWER personal cap, and clamps one set above it', () => {
    instanceSettings.setUploadCeilingMb(300);
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 25);
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(25 * MIB);
    // The registry has no max any more; a stored 500 is enforced as the ceiling,
    // the way a retention value above its ceiling is.
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 500);
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(300 * MIB);
  });

  it('bounds an operator-baked policy cap too', () => {
    instanceSettings.setUploadCeilingMb(300);
    expect(limits.chunkedCapBytesFor({ maxMb: 500 }, {})).toBe(300 * MIB);
    expect(limits.chunkedCapBytesFor({ maxMb: 50 }, {})).toBe(50 * MIB);
  });

  it('has no upper bound in code — the disk is the bound', () => {
    instanceSettings.setUploadCeilingMb(5000);
    expect(limits.effectiveUploadCapBytes(fresh.id, true)).toBe(5000 * MIB);
  });

  it('reads a stored value that will not parse as "never set"', () => {
    instanceSettings.setUploadCeilingMb(300);
    db.prepare('UPDATE instance_settings SET value = ? WHERE key = ?').run(
      'lots',
      instanceSettings.UPLOAD_CEILING_MB_KEY,
    );
    expect(limits.uploadCeilingMb()).toBe(200);
  });

  it('is what advertisedUploadLimits hands a client as the bound on its own cap', () => {
    instanceSettings.setUploadCeilingMb(300);
    expect(limits.advertisedUploadLimits(fresh.id, true).uploadCeilingBytes).toBe(300 * MIB);
  });
});

// #872: the longest edge the pipeline keeps, resolved in ONE place so the number a
// client is told and the maxDim sharp is handed can't disagree.
describe('staticImageMaxDimension', () => {
  it("is the user's own setting when the uploader bakes no policy", () => {
    expect(limits.staticImageMaxDimension(null, { 'uploads.image.max_dimension': 1024 })).toBe(
      1024,
    );
    expect(limits.staticImageMaxDimension({}, { 'uploads.image.max_dimension': 1024 })).toBe(1024);
  });

  // The hosted trap: on a cell the operator's value wins and the tenant's is
  // ignored — the tenant's being exactly what a client reading settings would see.
  it("lets an operator-baked policy override the user's setting, in either direction", () => {
    const settings = { 'uploads.image.max_dimension': 8192 };
    expect(limits.staticImageMaxDimension({ maxDim: 512 }, settings)).toBe(512);
    expect(
      limits.staticImageMaxDimension({ maxDim: 4096 }, { 'uploads.image.max_dimension': 1024 }),
    ).toBe(4096);
  });

  // sharp rejects a resize to 0 or a fraction, and a client told 0 would be asked for
  // an image with no pixels. The seed clamps, but resolve.ts takes any finite number.
  it('never resolves to a dimension that is not whole positive pixels', () => {
    const settings = { 'uploads.image.max_dimension': 1024 };
    expect(limits.staticImageMaxDimension({ maxDim: 0 }, settings)).toBe(1024);
    expect(limits.staticImageMaxDimension({ maxDim: -5 }, settings)).toBe(1024);
    expect(limits.staticImageMaxDimension({ maxDim: 1500.7 }, settings)).toBe(1500);
  });

  it('falls back to the registry default, not a second hardcoded one', async () => {
    const { getOption } = await import('./settingsRegistry.js');
    expect(limits.staticImageMaxDimension(null, { 'uploads.image.max_dimension': 'junk' })).toBe(
      getOption('uploads.image.max_dimension')!.default,
    );
  });
});

describe('advertisedUploadLimits', () => {
  it('carries the cap and the dimension the pipeline would use for this user', async () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 30);
    setUserSetting(user.id, 'uploads.image.max_dimension', 1600);
    try {
      expect(limits.advertisedUploadLimits(user.id, false)).toEqual({
        maxUploadBytes: 30 * MIB,
        maxStaticImageDimension: 1600,
        maxChunkedUploadBytes: 30 * MIB,
        uploadChunkBytes: 16 * MIB,
        uploadCeilingBytes: 200 * MIB,
      });
    } finally {
      const { deleteUserSetting } = await import('../db/settings.js');
      deleteUserSetting(user.id, 'uploads.image.max_upload_mb');
      deleteUserSetting(user.id, 'uploads.image.max_dimension');
    }
  });

  it('answers for a user with no settings row at all (registry default applies)', () => {
    expect(limits.advertisedUploadLimits(fresh.id, true).maxStaticImageDimension).toBe(2048);
  });
});

// #650: a chunked upload's proxy ceiling caps the chunk, not the file.
describe('chunked uploads', () => {
  afterEach(() => {
    delete process.env.LURKER_MAX_UPLOAD_MB;
  });

  it('caps the chunk at 16 MiB, or at the declared proxy limit when that is less', () => {
    expect(limits.uploadChunkBytes()).toBe(16 * MIB);
    process.env.LURKER_MAX_UPLOAD_MB = '10';
    expect(limits.uploadChunkBytes()).toBe(10_000_000 - 64 * 1024);
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.uploadChunkBytes()).toBe(16 * MIB);
  });

  it('leaves the proxy limit out of the file cap, and keeps the instance ceiling', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '10';
    const settings = { 'uploads.image.max_upload_mb': 150 };
    expect(limits.capBytesFor(null, settings)).toBe(10_000_000 - 64 * 1024);
    expect(limits.chunkedCapBytesFor(null, settings)).toBe(150 * MIB);
    expect(limits.chunkedCapBytesFor({ maxMb: 500 }, settings)).toBe(limits.uploadCeilingBytes());
  });
});

// #649: a caller with its own, larger limit (imports allow 500 MB) needs the raw
// declaration. transportCapBytes() reports "unset" as the upload path's instance
// ceiling, so reusing it would have silently cost imports 300 MB of headroom.
describe('clampToTransport', () => {
  const IMPORT_LIMIT = 500 * 1024 * 1024;

  it('leaves a larger own-limit ALONE when no ceiling is declared', () => {
    expect(limits.clampToTransport(IMPORT_LIMIT)).toBe(IMPORT_LIMIT);
    expect(limits.transportCapBytes()).toBe(limits.uploadCeilingBytes()); // the trap
  });

  it('lowers it to the declared ceiling', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.clampToTransport(IMPORT_LIMIT)).toBe(100 * 1_000_000 - ENVELOPE);
  });

  it('never RAISES an own-limit that is already lower than the ceiling', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '400';
    expect(limits.clampToTransport(10 * 1024 * 1024)).toBe(10 * 1024 * 1024);
  });

  it('is not bounded by the upload ceiling — that is an upload-path rule', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '400';
    expect(limits.clampToTransport(IMPORT_LIMIT)).toBeGreaterThan(limits.uploadCeilingBytes());
  });
});

describe('declaredTransportCapBytes', () => {
  it('is null when unset, distinguishing "no ceiling" from "200 MB"', () => {
    expect(limits.declaredTransportCapBytes()).toBeNull();
  });

  it('is null for a value that will not parse', () => {
    // Stub console.warn: this trips the warn-once path, and whether it actually
    // prints depends on whether an earlier test already latched it. Stubbing
    // makes the output the same either way, so reordering this file can't start
    // spraying warnings through an unrelated suite run.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.LURKER_MAX_UPLOAD_MB = '100m';
    expect(limits.declaredTransportCapBytes()).toBeNull();
  });
});

describe('clampUploadCapBytes', () => {
  it('never resolves to a zero or negative cap', () => {
    expect(limits.clampUploadCapBytes(0)).toBe(1);
    expect(limits.clampUploadCapBytes(-5)).toBe(1);
  });

  // multer 2.4 throws on a non-integer fileSize, so a policy maxMb of 0.3 would 500
  // every upload rather than cap it.
  it('resolves to whole bytes', () => {
    expect(limits.clampUploadCapBytes(0.3 * MIB)).toBe(314572);
  });

  it('applies the transport ceiling to a policy cap the operator baked higher', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.clampUploadCapBytes(200 * MIB)).toBe(100 * 1_000_000 - ENVELOPE);
  });
});

describe('formatCapMb', () => {
  // A whole number would be a lie once the envelope headroom is subtracted:
  // "exceeds 5 MB" when the real limit is 4.7 sends the user back with another
  // file that fails exactly the same way.
  it('keeps a decimal when the cap is not a whole MB, and rounds DOWN', () => {
    expect(limits.formatCapMb(5 * 1_000_000 - ENVELOPE)).toBe('4.7');
    expect(limits.formatCapMb(25 * MIB)).toBe('25');
  });

  it('drops the decimal on larger caps, where it is noise', () => {
    expect(limits.formatCapMb(100 * 1_000_000 - ENVELOPE)).toBe('95');
  });
});
