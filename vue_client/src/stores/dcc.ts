// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client store for the DCC download manager (#270 phase 2). Mirrors the server's
// dcc_transfers rows and backs the Transfers view: the initial list comes from
// GET /api/dcc, then live state changes arrive over the WS as `dcc-transfer`
// frames (applyTransfer). Acting on a transfer (accept / reject / cancel) goes
// over POST and the authoritative row echoes back — both through the action's
// response and, redundantly, the live frame the server publishes on the change.
//
// DCC is OFF for almost everyone (a self-host opt-in + per-user grant; dark on
// hosted cells), so this store stays empty and the UI affordance stays hidden
// until a transfer actually exists. There's no boot fetch: the store loads
// lazily when the Transfers modal opens or `/dcc list` runs, and the live frame
// reveals the affordance the moment an offer lands.

import { defineStore } from 'pinia';
import { api } from '../api.js';

// Mirror of the server DccTransferState union (db/dccTransfers.ts). Two entry
// states (requested / pending_approval), an active receive path, and terminal
// states. Kept in sync by hand — the wire is plain JSON.
export type DccState =
  | 'requested'
  | 'pending_approval'
  | 'connecting'
  | 'receiving'
  | 'stalled'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

// How a completed transfer verified against the filename CRC32 (server's
// DccCrcStatus). Only meaningful once `completed`.
export type DccCrcStatus = 'ok' | 'mismatch' | 'absent' | 'unverified';

// The subset of the server row the UI reads. The server ships the whole row;
// extra columns (peer_host/port, token, trigger_text, …) are ignored here.
export interface DccTransfer {
  id: number;
  /** Null once the network was deleted: the row and its file stay (#1125). */
  network_id: number | null;
  peer_nick: string;
  filename: string;
  advertised_size: number;
  received_bytes: number;
  state: DccState;
  crc_status: DccCrcStatus | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** When the user deleted the received file from the server (#1125). */
  file_deleted_at?: string | null;
  /** Non-null while this row owns a file on the server. Used only as that
   *  signal: the path itself is never shown. */
  destination_path?: string | null;
  /** The kept file a completed receive produced, while it is kept (#1133). */
  file_id?: number | null;
}

/** A file the account keeps on the server (#1133): a completed receive, or
 *  (with #1086) one uploaded to send. */
export interface DccFile {
  id: number;
  name: string;
  size: number;
  origin: 'received' | 'uploaded';
  created_at: string;
  /** The transfer that received it, and from whom on which network. */
  transfer_id: number | null;
  peer_nick: string | null;
  network_id: number | null;
}

export type DccPanelTab = 'transfers' | 'files';

// Where a kept file downloads from (#1133).
export function keptFileUrl(id: number): string {
  return `/api/dcc/files/${id}/file`;
}

// States that can still change — a transfer in one of these is "active" (drives
// the affordance badge) and is the only thing /dcc cancel meaningfully targets.
export const ACTIVE_STATES: ReadonlySet<DccState> = new Set([
  'requested',
  'pending_approval',
  'connecting',
  'receiving',
  'stalled',
  'verifying',
]);

// Terminal states a transfer never legitimately leaves (a row id is one-shot).
// Used to drop a stale snapshot that would rewind a finished row — see
// applyTransfer.
const TERMINAL_STATES: ReadonlySet<DccState> = new Set([
  'completed',
  'failed',
  'rejected',
  'cancelled',
]);

// True while a transfer is non-terminal — i.e. `/dcc cancel` (or the modal's
// Cancel button) can still act on it. This INCLUDES a pending_approval offer:
// cancelling one declines it, same as reject. The modal surfaces Reject rather
// than Cancel for a pending offer (its pending_approval branch takes precedence
// over the isCancellable branch), but the predicate itself is just "not yet in a
// terminal state", so it's true for pending too.
export function isCancellable(t: DccTransfer): boolean {
  return ACTIVE_STATES.has(t.state);
}

// Download progress as a clamped 0–100 integer. Shared by the modal's progress
// bar and the /dcc list output so the two never diverge (and a bot that
// over-sends can't render >100%).
export function percentReceived(t: DccTransfer): number {
  if (!t.advertised_size || t.advertised_size <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((t.received_bytes / t.advertised_size) * 100)));
}

// Whether a finished transfer left a file on the server to download or delete
// (#1125): a completed one, or a partial from one that failed or was cancelled.
// A row stops owning its file when the user deletes it, or when a newer
// transfer takes over the path (a resume continuing its partial).
export function hasFile(t: DccTransfer): boolean {
  return !ACTIVE_STATES.has(t.state) && !!t.destination_path;
}

// Where a completed transfer's file downloads from (#1079). The modal's link
// and `/dcc download` both use it.
export function dccFileUrl(id: number): string {
  return `/api/dcc/${id}/file`;
}

// Why GET /api/dcc/:id/file refused, by status. The download is checked with a
// HEAD, which carries no body, so the server's reason has to be restated here.
const DOWNLOAD_REFUSALS: Record<number, string> = {
  // Downloads need only the instance switch, never a grant.
  403: 'DCC is turned off on this server',
  404: 'transfer not found',
  409: 'transfer is not complete',
  410: 'file is no longer on the server',
};

type DccAction = 'accept' | 'reject' | 'cancel';

// Dedupe concurrent loads (the `/dcc list` command and the modal's mount both
// fetch) so every awaiter shares one in-flight request and sees the same rows.
// Held module-local, not in state — same rationale as the toasts store's action
// handlers and the drafts store's timers (Pinia state stays serializable).
let inflightLoad: Promise<DccTransfer[]> | null = null;
let inflightFiles: Promise<DccFile[]> | null = null;
// Frames that land while the files list loads: the response was read before
// them, so they are applied again on top of it.
let filesMissed: Array<DccFile | number> = [];

// Hand a file to the browser's download manager, after a HEAD: a refusal
// handed to the browser is saved as a .json file of the error (or, without
// `download`, navigates the app to it), so it has to be caught here and shown
// instead. Throws the refusal, restated, since a HEAD carries no body.
async function saveThroughBrowser(url: string, refusals: Record<number, string>): Promise<void> {
  try {
    await api(url, { method: 'HEAD' });
  } catch (e: any) {
    throw new Error(refusals[e?.status] || e?.message || 'download failed', { cause: e });
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.click();
}

// Why GET /api/dcc/files/:id/file refused, by status.
const KEPT_DOWNLOAD_REFUSALS: Record<number, string> = {
  403: 'DCC is turned off on this server',
  404: 'file not found',
  410: 'file is no longer on the server',
};

export const useDccStore = defineStore('dcc', {
  state: () => ({
    transfers: [] as DccTransfer[],
    loaded: false,
    loading: false,
    listError: '',
    // Whether the Transfers modal is open. Lives in the store (not a view-local
    // ref) so `/dcc list` can open it from MessageInput, mirroring the
    // composable-backed opens (useMediaViewer, useChannelListModal).
    panelOpen: false,
    // Which list the panel shows.
    panelTab: 'transfers' as DccPanelTab,
    // The files the account keeps (#1133), newest first.
    files: [] as DccFile[],
    filesLoaded: false,
    filesLoading: false,
    filesError: '',
    // Per-file action in flight, and its last error, as for transfers.
    fileBusy: {} as Record<number, boolean>,
    fileError: {} as Record<number, string>,
    // Per-transfer action in flight (disables that row's buttons).
    busy: {} as Record<number, boolean>,
    // Per-transfer last action error (cleared on the next attempt / success).
    actionError: {} as Record<number, string>,
  }),
  getters: {
    hasAny: (s): boolean => s.transfers.length > 0 || s.files.length > 0,
    // Unsolicited offers awaiting a decision — the urgent, you-must-act count
    // that warn-colors the affordance.
    pendingCount: (s): number => s.transfers.filter((t) => t.state === 'pending_approval').length,
  },
  actions: {
    // Fetch the user's transfers (newest first; the server already orders by id
    // DESC). Idempotent under concurrency via the shared in-flight promise.
    async load(): Promise<DccTransfer[]> {
      if (inflightLoad) return inflightLoad;
      this.loading = true;
      this.listError = '';
      inflightLoad = (async () => {
        try {
          const { transfers } = await api<{ transfers: DccTransfer[] }>('/api/dcc');
          this.transfers = (transfers || []).toSorted((a, b) => b.id - a.id);
          this.loaded = true;
          return this.transfers;
        } catch (e: any) {
          this.listError = e?.message || 'failed to load transfers';
          throw e;
        } finally {
          this.loading = false;
          inflightLoad = null;
        }
      })();
      return inflightLoad;
    },

    // Upsert a single row from a live `dcc-transfer` frame or an action response.
    // The id is immutable, so an existing row is replaced in place; a new one is
    // spliced in keeping the list id-DESC (a fresh offer has the largest id, so
    // this is usually a prepend).
    //
    // WS frames and POST action responses are independent, unordered channels, so
    // a stale snapshot can arrive after a newer one. Guard against the one case
    // that matters: a terminal row must never rewind to an active state (e.g. a
    // cancel/accept POST response carrying 'receiving' resolving after the live
    // 'cancelled'/'completed' frame already landed). Drop such a regression.
    applyTransfer(t: DccTransfer): void {
      if (!t || typeof t.id !== 'number') return;
      const idx = this.transfers.findIndex((x) => x.id === t.id);
      if (idx >= 0) {
        if (TERMINAL_STATES.has(this.transfers[idx].state) && !TERMINAL_STATES.has(t.state)) return;
        this.transfers[idx] = t;
        return;
      }
      const at = this.transfers.findIndex((x) => x.id < t.id);
      if (at === -1) this.transfers.push(t);
      else this.transfers.splice(at, 0, t);
    },

    async accept(id: number): Promise<DccTransfer> {
      return this.act(id, 'accept');
    },
    async reject(id: number): Promise<DccTransfer> {
      return this.act(id, 'reject');
    },
    async cancel(id: number): Promise<DccTransfer> {
      return this.act(id, 'cancel');
    },

    // Shared accept/reject/cancel path: POST /api/dcc/:id/<action>, apply the
    // returned authoritative row, and surface a per-row error on failure (a 409
    // when accepting on a disconnected network, a 404 for an unknown id).
    async act(id: number, action: DccAction): Promise<DccTransfer> {
      return this.changeRow(id, `/api/dcc/${id}/${action}`, 'POST', `${action} failed`);
    },

    // Remove a finished transfer's file from the server (#1125). The row stays,
    // marked deleted.
    async deleteFile(id: number): Promise<DccTransfer> {
      return this.changeRow(id, dccFileUrl(id), 'DELETE', 'delete failed');
    },

    // A request that answers with the transfer's authoritative row: the row's
    // buttons are disabled while it runs, the row is applied, and a refusal
    // shows on the row.
    async changeRow(
      id: number,
      url: string,
      method: 'POST' | 'DELETE',
      fallback: string,
    ): Promise<DccTransfer> {
      this.busy[id] = true;
      delete this.actionError[id];
      try {
        const { transfer } = await api<{ transfer: DccTransfer }>(url, { method });
        if (transfer) this.applyTransfer(transfer);
        return transfer;
      } catch (e: any) {
        this.actionError[id] = e?.message || fallback;
        throw e;
      } finally {
        delete this.busy[id];
      }
    },

    // Save a completed transfer's file through the browser's download manager
    // (#1079). Checked with a HEAD first: a refusal handed to the browser is
    // saved as a .json file of the error (or, without `download`, navigates the
    // app to it), so a file removed on the box has to be caught here and shown
    // on the row instead.
    async download(id: number): Promise<void> {
      this.busy[id] = true;
      delete this.actionError[id];
      try {
        await saveThroughBrowser(dccFileUrl(id), DOWNLOAD_REFUSALS);
      } catch (e: any) {
        this.actionError[id] = e.message;
        throw e;
      } finally {
        delete this.busy[id];
      }
    },

    // The files the account keeps (#1133), shared in-flight like load().
    async loadFiles(): Promise<DccFile[]> {
      if (inflightFiles) return inflightFiles;
      this.filesLoading = true;
      this.filesError = '';
      filesMissed = [];
      inflightFiles = (async () => {
        try {
          const { files } = await api<{ files: DccFile[] }>('/api/dcc/files');
          this.files = (files || []).toSorted((a, b) => b.id - a.id);
          const missed = filesMissed;
          filesMissed = [];
          for (const op of missed) {
            if (typeof op === 'number') this.dropFile(op);
            else this.applyFile(op);
          }
          this.filesLoaded = true;
          return this.files;
        } catch (e: any) {
          this.filesError = e?.message || 'failed to load files';
          throw e;
        } finally {
          this.filesLoading = false;
          inflightFiles = null;
        }
      })();
      return inflightFiles;
    },

    // A file from a live `dcc-file` frame: new, kept in id-DESC order.
    applyFile(f: DccFile): void {
      if (!f || typeof f.id !== 'number') return;
      if (inflightFiles) filesMissed.push(f);
      const idx = this.files.findIndex((x) => x.id === f.id);
      if (idx >= 0) {
        this.files[idx] = f;
        return;
      }
      const at = this.files.findIndex((x) => x.id < f.id);
      if (at === -1) this.files.push(f);
      else this.files.splice(at, 0, f);
    },

    // A file gone, from a `dcc-file-deleted` frame or our own delete.
    dropFile(id: number): void {
      if (inflightFiles) filesMissed.push(id);
      this.files = this.files.filter((f) => f.id !== id);
      delete this.fileBusy[id];
      delete this.fileError[id];
    },

    async downloadKeptFile(id: number): Promise<void> {
      this.fileBusy[id] = true;
      delete this.fileError[id];
      try {
        await saveThroughBrowser(keptFileUrl(id), KEPT_DOWNLOAD_REFUSALS);
      } catch (e: any) {
        this.fileError[id] = e.message;
        throw e;
      } finally {
        delete this.fileBusy[id];
      }
    },

    // Remove a kept file from the server. The transfer that received it stays,
    // marked deleted; its new row arrives as a `dcc-transfer` frame.
    async deleteKeptFile(id: number): Promise<void> {
      this.fileBusy[id] = true;
      delete this.fileError[id];
      try {
        await api(`/api/dcc/files/${id}`, { method: 'DELETE' });
        this.dropFile(id);
      } catch (e: any) {
        this.fileError[id] = e?.message || 'delete failed';
        throw e;
      } finally {
        delete this.fileBusy[id];
      }
    },

    // Offer a DCC chat to a peer. Resolves as soon as the offer is away — the
    // outcome (connected, refused, timed out) arrives as notices in the `=nick`
    // buffer, which materializes from those notices, so there is nothing useful
    // to await here.
    async openChat(networkId: number, nick: string, passive = false): Promise<void> {
      await api('/api/dcc/chat', { method: 'POST', body: { networkId, nick, passive } });
    },

    async closeChat(networkId: number, nick: string): Promise<void> {
      await api('/api/dcc/chat/close', { method: 'POST', body: { networkId, nick } });
    },

    // Open the Transfers modal on `tab` and (re)load both lists. Used by the
    // sidebar button, `/dcc list` and `/dcc files`. Load errors surface in the
    // modal (listError, filesError).
    open(tab: DccPanelTab = 'transfers'): void {
      this.panelOpen = true;
      this.panelTab = tab;
      this.load().catch(() => {
        /* surfaced via listError */
      });
      this.loadFiles().catch(() => {
        /* surfaced via filesError */
      });
    },
    close(): void {
      this.panelOpen = false;
    },

    // After the socket reconnects: frames sent while it was down are gone, so
    // a list already shown is fetched again.
    resync(): void {
      if (this.loaded) this.load().catch(() => {});
      if (this.filesLoaded) this.loadFiles().catch(() => {});
    },
  },
});
