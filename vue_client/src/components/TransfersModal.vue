<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Transfers view for the DCC download manager (#270 phase 2). Lists the user's
  inbound DCC transfers and lets them act on each: accept / reject an unsolicited
  offer, cancel one in flight, or download a completed file (#1079). The list
  seeds from GET /api/dcc on open and then updates live as `dcc-transfer` frames
  arrive over the WS. Everything but the download is also available headless via
  /dcc — this is a view over that core.

  A second tab lists the files the account keeps (#1133), apart from the
  transfers that brought them: GET /api/dcc/files, then `dcc-file` and
  `dcc-file-deleted` frames. `/dcc files` opens it. So a finished transfer is
  only history: its × (and Clear all, and `/dcc clear`) takes it off the list
  and leaves the file. Deleting a file happens under Files.

  Files are also what you send (#1086): Send to… on a file offers it to a nick,
  and `/dcc send <nick>` opens Files picking one for that nick, with an upload
  for a file that isn't here yet. A send is a transfer like any other, "to"
  its peer where a receive is "from".
-->

<template>
  <AppModal word="transfers" title="transfers" size="xl" fill-height @close="$emit('close')">
    <div class="tab-bar">
      <TabStrip v-model="dcc.panelTab" :tabs="TABS" label="DCC" />
      <button
        v-if="dcc.panelTab === 'transfers' && dcc.transfers.some(clearsWithAll)"
        class="link"
        :disabled="dcc.clearing"
        @click="onClearAll"
      >
        Clear all
      </button>
    </div>

    <template v-if="dcc.panelTab === 'files'">
      <p v-if="dcc.filesError" class="error">{{ dcc.filesError }}</p>
      <div v-if="dcc.pick" class="pick">
        <span>
          Pick a file to send to <span class="peer">{{ dcc.pick.nick }}</span
          >, or
          <button class="link inline" :disabled="!!dcc.uploading" @click="chooseUpload">
            upload one…
          </button>
        </span>
        <button class="link" @click="dcc.pick = null">cancel</button>
      </div>
      <p v-if="dcc.uploading" class="uploading">
        Uploading {{ dcc.uploading.name }}… {{ dcc.uploading.percent }}%
      </p>
      <p v-if="dcc.uploadError" class="error">{{ dcc.uploadError }}</p>
      <input ref="uploadInput" type="file" hidden @change="onUploadChosen" />
      <div class="list-wrap">
        <ul v-if="dcc.files.length" class="list">
          <li v-for="f in dcc.files" :key="f.id" class="row">
            <div class="icon muted"><FileIcon /></div>
            <div class="meta">
              <div class="filename" :title="f.name">{{ f.name }}</div>
              <div class="sub">{{ fileLine(f) }}</div>
              <form v-if="sendingTo?.fileId === f.id" class="send-to" @submit.prevent="onSendTo(f)">
                <input
                  v-model="sendingTo.nick"
                  class="nick"
                  placeholder="nick"
                  aria-label="nick to send to"
                  autofocus
                  @keydown.esc="sendingTo = null"
                />
                <select
                  v-if="connectedNetworks.length > 1"
                  v-model="sendingTo.networkId"
                  aria-label="network"
                >
                  <option v-for="n in connectedNetworks" :key="n.id" :value="n.id">
                    {{ n.name }}
                  </option>
                </select>
                <label title="They listen and this server connects to them">
                  <input v-model="sendingTo.passive" type="checkbox" /> passive
                </label>
                <button
                  class="link"
                  type="submit"
                  :disabled="dcc.fileBusy[f.id] || !sendingTo.nick.trim()"
                >
                  send
                </button>
                <button class="link" type="button" @click="sendingTo = null">cancel</button>
              </form>
              <div v-if="dcc.fileError[f.id]" class="err">{{ dcc.fileError[f.id] }}</div>
            </div>
            <div class="row-actions">
              <button
                v-if="dcc.pick"
                class="link accept"
                :disabled="dcc.fileBusy[f.id]"
                @click="onSendPicked(f)"
              >
                Send
              </button>
              <template v-else>
                <button
                  v-if="dcc.account?.send && connectedNetworks.length"
                  class="link"
                  :disabled="dcc.fileBusy[f.id]"
                  @click="startSendTo(f)"
                >
                  Send to…
                </button>
                <button class="link" :disabled="dcc.fileBusy[f.id]" @click="onDownloadFile(f)">
                  Download
                </button>
                <button class="link reject" :disabled="dcc.fileBusy[f.id]" @click="onDeleteFile(f)">
                  Delete
                </button>
              </template>
            </div>
          </li>
        </ul>
        <p v-else-if="dcc.filesLoading && !dcc.filesLoaded" class="empty">Loading…</p>
        <p v-else-if="dcc.filesLoaded" class="empty">
          No files. Files you receive, and files you upload to send, are kept here until you delete
          them.
        </p>
      </div>
    </template>

    <template v-else>
      <p v-if="dcc.listError" class="error">{{ dcc.listError }}</p>
      <p v-if="dcc.clearError" class="error">{{ dcc.clearError }}</p>

      <div class="list-wrap">
        <ul v-if="dcc.transfers.length" class="list">
          <li v-for="t in dcc.transfers" :key="t.id" class="row">
            <div class="icon" :class="stateClass(t.state)" :title="stateLabel(t.state)">
              <component :is="stateIcon(t.state)" />
            </div>
            <div class="meta">
              <div class="filename" :title="t.filename">{{ t.filename }}</div>
              <div class="sub">{{ subLine(t) }}</div>
              <!-- Progress bar while bytes can still arrive (or after, if partial). -->
              <div v-if="showProgress(t)" class="progress" :title="progressTitle(t)">
                <div class="bar">
                  <div class="fill" :style="{ width: percentReceived(t) + '%' }"></div>
                </div>
                <span class="progress-text">{{ progressTitle(t) }}</span>
              </div>
              <div v-if="crcBadge(t)" class="crc" :class="crcBadge(t)!.cls">
                <component :is="crcBadge(t)!.icon" /> {{ crcBadge(t)!.text }}
              </div>
              <div v-if="t.error && isErrorState(t.state)" class="err" :title="t.error">
                {{ t.error }}
              </div>
              <div v-if="dcc.actionError[t.id]" class="err">{{ dcc.actionError[t.id] }}</div>
            </div>
            <div class="row-actions">
              <template v-if="t.state === 'pending_approval'">
                <button class="link accept" :disabled="dcc.busy[t.id]" @click="onAccept(t)">
                  Accept
                </button>
                <button class="link reject" :disabled="dcc.busy[t.id]" @click="onReject(t)">
                  Reject
                </button>
              </template>
              <button
                v-else-if="isCancellable(t)"
                class="link reject"
                :disabled="dcc.busy[t.id]"
                @click="onCancel(t)"
              >
                Cancel
              </button>
              <template v-else>
                <button
                  v-if="t.state === 'completed' && hasFile(t)"
                  class="link"
                  :disabled="dcc.busy[t.id]"
                  @click="onDownload(t)"
                >
                  Download
                </button>
                <button
                  class="link clear"
                  :disabled="dcc.busy[t.id]"
                  title="Clear from list"
                  aria-label="Clear from list"
                  @click="onClear(t)"
                >
                  <XIcon />
                </button>
              </template>
            </div>
          </li>
        </ul>
        <p v-else-if="dcc.loading && !dcc.loaded" class="empty">Loading…</p>
        <p v-else-if="dcc.loaded" class="empty">
          No transfers. Files sent to you, and files you send, show up here.
        </p>
      </div>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import TabStrip from './TabStrip.vue';
import {
  useDccStore,
  isCancellable,
  hasFile,
  holdsPartial,
  percentReceived,
  type DccFile,
  type DccPanelTab,
  type DccTransfer,
  type DccState,
} from '../stores/dcc.js';
import { useNetworksStore } from '../stores/networks.js';
import { formatRelative } from '../utils/timestamp.js';
import { joinMeta } from '../utils/metaLine.js';
import { formatBytes } from '../utils/formatBytes.js';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleQuestionMarkIcon,
  FileIcon,
  InfoIcon,
  PauseIcon,
  ShieldHalfIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue';
import type { LucideIcon } from '@lucide/vue';

defineEmits<{ close: [] }>();

const dcc = useDccStore();
const networks = useNetworksStore();

onMounted(() => {
  // Idempotent under the store's in-flight guard — safe even when `/dcc list`
  // already kicked a load before opening the modal.
  dcc.load().catch(() => {
    /* surfaced via dcc.listError */
  });
  dcc.loadFiles().catch(() => {
    /* surfaced via dcc.filesError */
  });
});

const TABS: { id: DccPanelTab; label: string }[] = [
  { id: 'transfers', label: 'Transfers' },
  { id: 'files', label: 'Files' },
];

// "from alice • libera • 4.20 MB • 2d ago", or "uploaded • …"
function fileLine(f: DccFile): string {
  return joinMeta([
    f.peer_nick ? `from ${f.peer_nick}` : f.origin,
    f.peer_nick ? networkName(f.network_id) : '',
    formatBytes(f.size),
    formatRelative(f.created_at),
  ]);
}

function onDownloadFile(f: DccFile) {
  dcc.downloadKeptFile(f.id).catch(() => {
    /* error surfaced via dcc.fileError */
  });
}
function onDeleteFile(f: DccFile) {
  // The file is gone for good once deleted; the transfer stays as history.
  if (!confirm(`Delete "${f.name}" from the server?`)) return;
  dcc.deleteKeptFile(f.id).catch(() => {
    /* error surfaced via dcc.fileError */
  });
}

// The networks a file can go out on: those connected now.
const connectedNetworks = computed(() =>
  networks.networks.filter((n) => networks.states[n.id]?.state === 'connected'),
);

// The row whose Send to… is open, and what it holds.
const sendingTo = ref<{ fileId: number; nick: string; networkId: number; passive: boolean } | null>(
  null,
);

function startSendTo(f: DccFile) {
  // The network of the buffer in view, when it's connected; else the first.
  const active = networks.activeBuffer?.networkId;
  const list = connectedNetworks.value;
  const networkId = list.some((n) => n.id === active) ? active! : list[0].id;
  sendingTo.value = { fileId: f.id, nick: '', networkId, passive: false };
}

function onSendTo(f: DccFile) {
  const to = sendingTo.value;
  if (!to || !to.nick.trim()) return;
  dcc
    .sendFile(to.networkId, to.nick.trim(), f.id, to.passive)
    .then(() => {
      sendingTo.value = null;
      dcc.panelTab = 'transfers';
    })
    .catch(() => {
      /* error surfaced via dcc.fileError */
    });
}

function onSendPicked(f: DccFile) {
  dcc.sendPicked(f.id).catch(() => {
    /* error surfaced via dcc.fileError */
  });
}

const uploadInput = ref<HTMLInputElement | null>(null);

function chooseUpload() {
  uploadInput.value?.click();
}

// A file chosen while picking: up it goes, then out to who it was picked for.
async function onUploadChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const chosen = input.files?.[0];
  input.value = '';
  if (!chosen) return;
  try {
    const kept = await dcc.uploadFile(chosen);
    if (dcc.pick) await dcc.sendPicked(kept.id);
  } catch {
    /* surfaced via dcc.uploadError, or the file's own error */
  }
}

function networkName(id: number | null): string {
  if (id === null) return 'deleted network';
  return networks.networkById(id)?.name || `net:${id}`;
}

const STATE_LABELS: Record<DccState, string> = {
  requested: 'requested',
  pending_approval: 'awaiting approval',
  connecting: 'connecting',
  receiving: 'receiving',
  stalled: 'stalled',
  verifying: 'verifying',
  offered: 'offered',
  sending: 'sending',
  completed: 'completed',
  failed: 'failed',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

function stateLabel(s: DccState): string {
  return STATE_LABELS[s] || s;
}

function stateClass(s: DccState): string {
  if (s === 'completed') return 'good';
  if (s === 'failed') return 'bad';
  if (s === 'stalled') return 'warn';
  if (s === 'rejected' || s === 'cancelled') return 'muted';
  return 'accent'; // requested / pending / connecting / receiving / verifying / offered / sending
}

function stateIcon(s: DccState): LucideIcon {
  if (s === 'completed') return CircleCheckIcon;
  if (s === 'failed') return CircleAlertIcon;
  if (s === 'rejected' || s === 'cancelled') return BanIcon;
  if (s === 'pending_approval') return CircleQuestionMarkIcon;
  if (s === 'stalled') return PauseIcon;
  if (s === 'verifying') return ShieldHalfIcon;
  if (s === 'offered' || s === 'sending') return ArrowUpIcon;
  return ArrowDownIcon; // requested / connecting / receiving
}

function isErrorState(s: DccState): boolean {
  return s === 'failed' || s === 'stalled';
}

// "from alice • libera • receiving • 2m ago", or "to bob • …" for a send
function subLine(t: DccTransfer): string {
  return joinMeta([
    t.direction === 'send' ? `to ${t.peer_nick}` : `from ${t.peer_nick}`,
    networkName(t.network_id),
    stateLabel(t.state),
    t.file_deleted_at ? 'file deleted' : '',
    formatRelative(t.updated_at),
  ]);
}

// Only show the progress bar once a download has actually started — a
// pending_approval offer hasn't, so it must not render a 0% bar that implies
// one. A stalled/failed transfer with a partial keeps its bar so the user sees
// how far it got.
function showProgress(t: DccTransfer): boolean {
  if (t.state === 'pending_approval' || t.state === 'requested' || t.state === 'offered') {
    return false;
  }
  return isCancellable(t) || (t.received_bytes > 0 && t.state !== 'completed');
}

function progressTitle(t: DccTransfer): string {
  const got = formatBytes(t.received_bytes);
  if (t.advertised_size > 0) {
    return `${got} / ${formatBytes(t.advertised_size)} (${percentReceived(t)}%)`;
  }
  return got;
}

interface CrcBadge {
  cls: string;
  icon: LucideIcon;
  text: string;
}

// Integrity badge — only meaningful once a transfer has completed. 'absent'
// (the filename carried no CRC, so size match is the only signal) and a null
// status render nothing, to avoid implying a verification that didn't happen.
function crcBadge(t: DccTransfer): CrcBadge | null {
  if (t.state !== 'completed') return null;
  if (t.crc_status === 'ok') {
    return { cls: 'good', icon: CheckIcon, text: 'checksum verified' };
  }
  if (t.crc_status === 'mismatch') {
    return { cls: 'bad', icon: TriangleAlertIcon, text: 'checksum mismatch' };
  }
  if (t.crc_status === 'unverified') {
    return { cls: 'muted', icon: InfoIcon, text: 'resumed — not verified' };
  }
  return null;
}

function onAccept(t: DccTransfer) {
  dcc.accept(t.id).catch(() => {
    /* error surfaced via dcc.actionError */
  });
}
function onReject(t: DccTransfer) {
  dcc.reject(t.id).catch(() => {
    /* error surfaced via dcc.actionError */
  });
}
function onDownload(t: DccTransfer) {
  dcc.download(t.id).catch(() => {
    /* error surfaced via dcc.actionError */
  });
}
// A finished row that holds part of a download takes those bytes with it, so
// it asks first; any other row goes and its file, if any, stays in Files.
function clearsWithAll(t: DccTransfer): boolean {
  return !isCancellable(t) && !holdsPartial(t);
}
function onClear(t: DccTransfer) {
  const partial = holdsPartial(t);
  if (partial && !confirm(`Delete the partial download of "${t.filename}"?`)) return;
  dcc.clearTransfer(t.id, partial).catch(() => {
    /* error surfaced via dcc.actionError */
  });
}
function onClearAll() {
  dcc.clearFinished().catch(() => {
    /* error surfaced via dcc.clearError */
  });
}
function onCancel(t: DccTransfer) {
  dcc.cancel(t.id).catch(() => {
    /* error surfaced via dcc.actionError */
  });
}
</script>

<style scoped>
.link {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: var(--space-2) var(--space-4);
}
.link:hover {
  color: var(--fg);
}
.link:disabled {
  color: var(--fg-muted);
  cursor: default;
}
.link.accept {
  color: var(--good);
}
.link.accept:hover:not(:disabled) {
  color: var(--fg);
}
.link.reject {
  color: var(--bad);
}
.link.reject:hover:not(:disabled) {
  color: var(--fg);
}
.link.clear {
  color: var(--fg-muted);
}
.link.clear:hover:not(:disabled) {
  color: var(--fg);
}

.link.inline {
  padding: 0;
}

.pick {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-4);
  margin: 0 0 var(--space-4);
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}
.peer {
  color: var(--fg);
  font-weight: 600;
}
.uploading {
  margin: 0 0 var(--space-4);
  color: var(--fg-muted);
}

.send-to {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-2);
}
.send-to .nick {
  width: 12em;
}
.send-to label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
}

.tab-bar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-4);
}

.error {
  margin: 0 0 var(--space-4);
  padding: var(--space-4) 0;
  color: var(--bad);
  border-bottom: 1px solid var(--border);
}

.list-wrap {
  /* Break out of card padding so the scrollbar sits against the card border. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: grid;
  grid-template-columns: max-content 1fr max-content;
  column-gap: var(--space-4);
  align-items: start;
  padding: var(--space-4) 0 var(--space-6);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-4);
}
.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: var(--icon-md);
}
.icon.good {
  color: var(--good);
}
.icon.bad {
  color: var(--bad);
}
.icon.warn {
  color: var(--warn);
}
.icon.accent {
  color: var(--accent);
}
.icon.muted {
  color: var(--fg-muted);
}
.meta {
  min-width: 0;
}
.filename {
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  color: var(--fg-muted);
  margin-top: var(--space-1);
}
.progress {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-2);
}
.bar {
  flex: 1;
  min-width: 0;
  height: 4px;
  background: var(--bg-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.progress-text {
  color: var(--fg-muted);
  flex-shrink: 0;
}
.crc {
  margin-top: var(--space-2);
}
.crc.good {
  color: var(--good);
}
.crc.bad {
  color: var(--bad);
}
.crc.muted {
  color: var(--fg-muted);
}
.err {
  color: var(--bad);
  margin-top: var(--space-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-left: var(--space-4);
}

.empty {
  padding: var(--space-9) 0;
  color: var(--fg-muted);
  text-align: center;
}
</style>
