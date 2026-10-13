// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Deleting an upload on the hosted service (node edition, control-plane #55).
// Every hosted upload goes through the operator's dropper, and a cell holds only
// its upload key, never the delete key, so a compromised cell can't wipe the
// bucket. The control plane does the deleting instead: it checks the upload is
// this cell's and this user's, deletes the file and thumbnail from R2, and
// purges the CDN. Same order as every other delete (decision 8): the bytes go
// first, and the history row is dropped only once the control plane says so,
// so a failure leaves the row for the user to retry.

import { isNodeMode } from '../utils/edition.js';
import {
  controlPlaneConfigured,
  requestOwnerDelete,
  reportUpload,
  type OwnerDeleteAnswer,
} from './moderationReport.js';
import { deleteUpload, getUploadForReport, markUploadSynced } from '../db/uploadHistory.js';
import * as systemLog from './systemLog.js';

/** Hosted rows are deletable (through the control plane) on a configured node. */
export function hostedDeleteAvailable(): boolean {
  return isNodeMode() && controlPlaneConfigured();
}

export type HostedDeleteResult =
  | { ok: true }
  | { ok: false; status: number; error: string; retryAfter?: number };

export async function deleteHostedUpload(userId: number, id: number): Promise<HostedDeleteResult> {
  let answer = await requestOwnerDelete(id, userId);
  // The control plane hasn't indexed it (its report never landed, or hasn't
  // yet): report it now, then ask once more.
  if (answer.code === 'not_indexed') {
    const row = getUploadForReport(userId, id);
    if (row) {
      const reported = await reportUpload({
        cell_upload_id: row.id,
        cell_user_id: row.user_id,
        url: row.url,
        thumb_url: row.thumbnail_url,
        mime: row.mime,
        byte_size: row.byte_size,
        width: row.width,
        height: row.height,
      });
      if (reported) {
        markUploadSynced(row.id);
        answer = await requestOwnerDelete(id, userId);
      }
    }
  }
  if (answer.status >= 200 && answer.status < 300) {
    deleteUpload(userId, id);
    return { ok: true };
  }
  return refusal(answer);
}

// What the user hears. The control plane's own wording is for operators; these
// are for the person who pressed delete.
function refusal(answer: OwnerDeleteAnswer): HostedDeleteResult & { ok: false } {
  switch (answer.code) {
    case 'taken_down':
      return { ok: false, status: 409, error: 'this upload was removed by moderation' };
    case 'rate_limited':
      return {
        ok: false,
        status: 429,
        error: 'too many deletes right now — try again shortly',
        retryAfter: answer.retryAfter,
      };
    case 'not_indexed':
      return {
        ok: false,
        status: 503,
        error: 'this upload is still being recorded — try again shortly',
      };
    case 'storage_unavailable':
      return { ok: false, status: 502, error: 'could not delete it right now — try again' };
    default:
      // Unreachable, unconfigured, or refused for a reason only the operator can
      // fix (wrong cell, not this user's): a gateway error for the user, the
      // reason in the system log for the operator.
      systemLog.log({
        scope: 'node',
        text: `hosted upload delete refused by the control plane: ${answer.status} ${answer.code ?? ''} ${answer.error ?? ''}`.trim(),
      });
      return {
        ok: false,
        status: answer.status === 503 ? 503 : 502,
        error: 'the upload host could not delete it',
      };
  }
}
