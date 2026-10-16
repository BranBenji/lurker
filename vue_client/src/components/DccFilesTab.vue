<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The body of the DCC window (#1085). It replaces the Transfers modal: a
  transfer's history is its lines in the peer's DM, so what is left to manage
  is what needs you now, what is moving, and what you keep.

    waiting for you  offers nobody has answered: Accept / Decline right there.
    in progress      everything moving or queued, a block per peer. A bot's
                     block is its XDCC queue: the pack out, then the packs
                     waiting, each removable, and Clear queue. A pack that
                     ended without its file stays until you Retry or dismiss it.
    kept             the files the account keeps (#1133): Download, Send to…,
                     Delete. `/dcc send <nick>` opens this picking one (#1086).

  Search and the type chips come from the window's filter bar. On a phone a
  row's actions sit behind ⋯, except an offer's and a queued pack's, which are
  the whole point of their rows.
-->

<template>
  <div class="dcc-tab">
    <p v-if="!granted" class="note">
      DCC isn't turned on for your account. You can still download and delete what's here.
    </p>
    <p v-if="dcc.listError" class="error">{{ dcc.listError }}</p>
    <p v-if="dcc.clearError" class="error">{{ dcc.clearError }}</p>
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
    <p v-if="dcc.uploading" class="muted">
      Uploading {{ dcc.uploading.name }}… {{ dcc.uploading.percent }}%
    </p>
    <p v-if="dcc.uploadError" class="error">{{ dcc.uploadError }}</p>
    <input ref="uploadInput" type="file" hidden @change="onUploadChosen" />

    <template v-if="offers.length">
      <div class="group">waiting for you</div>
      <ul class="list">
        <li v-for="t in offers" :key="t.id" class="row inline">
          <div class="glyph warn"><ArrowDownIcon /></div>
          <div class="meta">
            <div class="name">{{ t.filename }}</div>
            <div class="sub">{{ offerLine(t) }}</div>
            <div v-if="dcc.actionError[t.id]" class="err">{{ dcc.actionError[t.id] }}</div>
          </div>
          <div class="acts">
            <button class="link good" :disabled="dcc.busy[t.id]" @click="act(dcc.accept(t.id))">
              Accept
            </button>
            <button class="link bad" :disabled="dcc.busy[t.id]" @click="act(dcc.reject(t.id))">
              Decline
            </button>
          </div>
        </li>
      </ul>
    </template>

    <template v-if="peers.length">
      <div class="group">in progress</div>
      <section v-for="p in peers" :key="p.key" class="peer-block">
        <div class="peer-head">
          <span
            ><span class="peer">{{ p.nick }}</span>
            <span class="muted"> · {{ networkName(p.networkId) }}</span
            ><span v-if="p.queued" class="muted"> · {{ p.queued }} queued</span></span
          >
          <button
            v-if="p.queued && p.networkId != null"
            class="link bad"
            @click="act(dcc.unqueueXdcc(p.networkId, p.nick, null))"
          >
            Clear queue
          </button>
        </div>
        <ul class="list">
          <li
            v-for="t in p.rows"
            :key="t.id"
            class="row"
            :class="{ inline: t.state === 'queued', dim: t.state === 'queued' }"
          >
            <div class="glyph" :class="glyphClass(t)"><component :is="glyphIcon(t)" /></div>
            <div class="meta">
              <div class="name">{{ rowName(t) }}</div>
              <div v-if="rowLine(t)" class="sub">{{ rowLine(t) }}</div>
              <div v-if="showBar(t)" class="bar-row">
                <div class="bar">
                  <div class="fill" :style="{ width: percentReceived(t) + '%' }"></div>
                </div>
                <span class="sub">{{ progressText(t) }}</span>
              </div>
              <div v-if="dcc.actionError[t.id]" class="err">{{ dcc.actionError[t.id] }}</div>
            </div>
            <div class="acts">
              <button
                v-for="a in rowActions(t)"
                :key="a.label"
                class="link"
                :class="a.tone"
                :disabled="dcc.busy[t.id]"
                @click="a.run()"
              >
                {{ a.label }}
              </button>
            </div>
            <button
              v-if="rowActions(t).length"
              class="more"
              :aria-label="`Actions for ${rowName(t)}`"
              :aria-expanded="openMenu === `t${t.id}`"
              @click="toggleMenu(`t${t.id}`)"
            >
              <EllipsisIcon />
            </button>
            <div v-if="openMenu === `t${t.id}`" class="menu">
              <button
                v-for="a in rowActions(t)"
                :key="a.label"
                class="link"
                :class="a.tone"
                :disabled="dcc.busy[t.id]"
                @click="a.run()"
              >
                {{ a.label }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </template>

    <div class="group">
      <span>kept</span>
      <span v-if="dcc.files.length || usedBytes > 0">{{ storageLine }}</span>
    </div>
    <ul v-if="kept.length" class="list">
      <li v-for="f in kept" :key="f.id" class="row">
        <div class="glyph" :class="crcNotes.get(f.id)?.tone === 'bad' ? 'bad' : 'muted'">
          <FileIcon />
        </div>
        <div class="meta">
          <div class="name">{{ f.name }}</div>
          <div class="sub">
            <span>{{ fileLine(f) }}</span>
            <span v-if="crcNotes.get(f.id)">{{ ` ${META_SEPARATOR} ` }}</span>
            <span v-if="crcNotes.get(f.id)" class="crc" :class="crcNotes.get(f.id)!.tone">{{
              crcNotes.get(f.id)!.text
            }}</span>
          </div>
          <form v-if="sendingTo?.fileId === f.id" class="send-to" @submit.prevent="onSendTo(f)">
            <input
              v-model="sendingTo.nick"
              class="nick"
              placeholder="nick"
              aria-label="nick to send to"
              autofocus
              @keydown.esc.stop="sendingTo = null"
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
        <div class="acts" :class="{ always: !!dcc.pick }">
          <button
            v-for="a in fileActions(f)"
            :key="a.label"
            class="link"
            :class="a.tone"
            :disabled="dcc.fileBusy[f.id]"
            @click="a.run()"
          >
            {{ a.label }}
          </button>
        </div>
        <button
          v-if="!dcc.pick"
          class="more"
          :aria-label="`Actions for ${f.name}`"
          :aria-expanded="openMenu === `f${f.id}`"
          @click="toggleMenu(`f${f.id}`)"
        >
          <EllipsisIcon />
        </button>
        <div v-if="openMenu === `f${f.id}`" class="menu">
          <button
            v-for="a in fileActions(f)"
            :key="a.label"
            class="link"
            :class="a.tone"
            :disabled="dcc.fileBusy[f.id]"
            @click="a.run()"
          >
            {{ a.label }}
          </button>
        </div>
      </li>
    </ul>
    <p v-else-if="dcc.filesLoading && !dcc.filesLoaded" class="empty">Loading…</p>
    <p v-else-if="filtering && dcc.files.length" class="empty">Nothing matches.</p>
    <p v-else-if="dcc.filesLoaded" class="empty">
      No files yet. What people send you, and packs you queue with /xdcc, are kept here until you
      delete them.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ACTIVE_STATES,
  formatEta,
  holdsPartial,
  inFlight,
  percentReceived,
  retryable,
  samePeer,
  useDccStore,
  type DccFile,
  type DccTransfer,
} from '../stores/dcc.js';
import { useNetworksStore } from '../stores/networks.js';
import { isXdccPlaceholder } from '../../../shared/xdcc.js';
import type { UploadKind } from '../stores/uploads.js';
import { formatRelative } from '../utils/timestamp.js';
import { META_SEPARATOR, joinMeta } from '../utils/metaLine.js';
import { formatBytes } from '../utils/formatBytes.js';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleAlertIcon,
  EllipsisIcon,
  FileIcon,
  ListOrderedIcon,
  PauseIcon,
} from '@lucide/vue';
import type { LucideIcon } from '@lucide/vue';

const props = defineProps<{ query: string; kind: UploadKind | null }>();

const dcc = useDccStore();
const networks = useNetworksStore();

const granted = computed(() => {
  const a = dcc.account;
  return !a || a.chat || a.receive || a.send;
});

// ─── Filtering ───────────────────────────────────────────────────────────────
//
// Client-side: every DCC row and file is already here. A file's kind is read
// off its extension, since DCC carries no type.

const KIND_BY_EXT: Record<string, UploadKind> = {};
for (const [kind, exts] of [
  ['image', 'png jpg jpeg gif webp avif heic bmp svg tif tiff'],
  ['video', 'mkv mp4 webm avi mov m4v ts m2ts wmv flv mpg mpeg ogv 3gp'],
  ['audio', 'mp3 flac ogg opus m4a wav aac wma alac aiff'],
  ['text', 'txt md log nfo srt ass ssa sub vtt csv json xml'],
] as const) {
  for (const ext of exts.split(' ')) KIND_BY_EXT[ext] = kind;
}

function kindOf(name: string): UploadKind | null {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? null : (KIND_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null);
}

const filtering = computed(() => !!props.query.trim() || !!props.kind);

function matches(name: string): boolean {
  const q = props.query.trim().toLowerCase();
  if (q && !name.toLowerCase().includes(q)) return false;
  return !props.kind || kindOf(name) === props.kind;
}

// A queued pack has no name to filter on until its bot offers it: it stays in
// view under a search, so a queue never looks emptied by one.
function rowMatches(t: DccTransfer): boolean {
  return t.state === 'queued' || t.state === 'requested' || matches(t.filename);
}

// ─── Rows ────────────────────────────────────────────────────────────────────

const offers = computed(() =>
  dcc.transfers.filter((t) => t.state === 'pending_approval' && rowMatches(t)),
);

// A later try of the same pack exists — waiting, out, done or failed in its
// turn — so this one's ending has been taken care of.
function superseded(t: DccTransfer): boolean {
  return (
    t.pack != null &&
    dcc.transfers.some(
      (o) =>
        o.id > t.id &&
        o.pack === t.pack &&
        o.network_id === t.network_id &&
        samePeer(t.network_id, o.peer_nick, t.peer_nick),
    )
  );
}

// An ended row worth keeping in view: one with a partial download to resume
// or delete, or a queued pack that failed and wasn't retried.
function endedButOpen(t: DccTransfer): boolean {
  if (ACTIVE_STATES.has(t.state) || t.state === 'completed') return false;
  if (holdsPartial(t)) return !superseded(t);
  return t.state === 'failed' && t.pack != null && !superseded(t);
}

interface PeerBlock {
  key: string;
  nick: string;
  networkId: number | null;
  queued: number;
  rows: DccTransfer[];
}

// Out, then waiting in queue order, then ended — newest first within each.
function order(t: DccTransfer): number {
  if (t.state === 'queued') return 1;
  return inFlight(t) ? 0 : 2;
}

const peers = computed((): PeerBlock[] => {
  const blocks: PeerBlock[] = [];
  for (const t of dcc.transfers) {
    if (!(inFlight(t) || endedButOpen(t)) || !rowMatches(t)) continue;
    let b = blocks.find(
      (x) => x.networkId === t.network_id && samePeer(t.network_id, x.nick, t.peer_nick),
    );
    if (!b) {
      const key = `${t.network_id ?? 'x'}|${t.id}`;
      b = { key, nick: t.peer_nick, networkId: t.network_id, queued: 0, rows: [] };
      blocks.push(b);
    }
    b.rows.push(t);
    if (t.state === 'queued') b.queued++;
  }
  for (const b of blocks) {
    b.rows.sort(
      (a, c) =>
        order(a) - order(c) ||
        (a.state === 'queued' ? (a.queue_seq ?? 0) - (c.queue_seq ?? 0) : c.id - a.id),
    );
  }
  return blocks;
});

const kept = computed(() => dcc.files.filter((f) => matches(f.name)));
const crcNotes = computed(() => new Map(kept.value.map((f) => [f.id, crcNote(f)])));

// What the account's files take on disk (#1153), as Settings → DCC and the
// limit count it: kept files, and what each transfer that still owns a path
// has written, in flight or not. (An offer is checked against this plus what
// in-flight transfers still have to write.) The partials Delete partial can
// free are named.
const partialBytes = computed(() =>
  dcc.transfers.reduce((n, t) => (holdsPartial(t) ? n + t.received_bytes : n), 0),
);
const usedBytes = computed(
  () =>
    dcc.files.reduce((n, f) => n + f.size, 0) +
    dcc.transfers.reduce(
      (n, t) => (t.destination_path && t.file_id == null ? n + t.received_bytes : n),
      0,
    ),
);
const storageLine = computed(() => {
  const used = usedBytes.value;
  const limit = dcc.account?.limitBytes;
  return joinMeta([
    limit ? `${formatBytes(used)} of ${formatBytes(limit)}` : formatBytes(used),
    partialBytes.value > 0 && `${formatBytes(partialBytes.value)} in partials`,
  ]);
});

function networkName(id: number | null): string {
  if (id === null) return 'deleted network';
  return networks.networkById(id)?.name || `net:${id}`;
}

function offerLine(t: DccTransfer): string {
  return joinMeta([
    `from ${t.peer_nick}`,
    networkName(t.network_id),
    t.advertised_size > 0 ? formatBytes(t.advertised_size) : '',
    formatRelative(t.created_at),
  ]);
}

function rowName(t: DccTransfer): string {
  // A queued pack's placeholder name ("XDCC #31") says less than its number.
  if (isXdccPlaceholder(t.filename, t.pack)) return `#${t.pack}`;
  return t.filename;
}

function rowLine(t: DccTransfer): string {
  switch (t.state) {
    case 'queued':
      return '';
    case 'requested':
      return t.bot_acked_at ? "in the bot's queue" : 'asked, waiting for an answer';
    case 'connecting':
      return joinMeta([t.pack != null ? `#${t.pack}` : '', 'connecting']);
    case 'verifying':
      return 'checking the checksum';
    case 'offered':
      return `offered to ${t.peer_nick}, waiting for them to accept`;
    case 'receiving':
    case 'sending':
      return joinMeta([
        t.pack != null ? `#${t.pack}` : '',
        t.direction === 'send' ? `to ${t.peer_nick}` : '',
        t.attempt === 2 ? 'second try' : '',
      ]);
    case 'stalled':
    case 'failed':
    case 'cancelled':
    case 'rejected': {
      const at = t.advertised_size > 0 && t.received_bytes > 0 ? ` at ${percentReceived(t)}%` : '';
      const why = t.error ? `: ${t.error}` : '';
      const resume =
        holdsPartial(t) && t.pack == null ? ` · it resumes if ${t.peer_nick} sends it again` : '';
      return `${t.state === 'stalled' ? 'stalled' : 'failed'}${at}${why}${resume}`;
    }
    default:
      return '';
  }
}

function showBar(t: DccTransfer): boolean {
  if (t.state === 'receiving' || t.state === 'sending' || t.state === 'verifying') return true;
  return endedButOpen(t) && t.received_bytes > 0 && t.advertised_size > 0;
}

function progressText(t: DccTransfer): string {
  const rate = dcc.rates[t.id];
  const parts = [`${percentReceived(t)}%`];
  if (rate && inFlight(t)) {
    parts.push(`${formatBytes(rate.bps)}/s`);
    if (rate.etaSeconds != null) parts.push(`${formatEta(rate.etaSeconds)} left`);
  } else if (t.advertised_size > 0) {
    parts.push(`${formatBytes(t.received_bytes)} of ${formatBytes(t.advertised_size)}`);
  }
  return parts.join(' · ');
}

function glyphIcon(t: DccTransfer): LucideIcon {
  if (t.state === 'queued') return ListOrderedIcon;
  if (t.state === 'stalled') return PauseIcon;
  if (!ACTIVE_STATES.has(t.state)) return CircleAlertIcon;
  return t.direction === 'send' ? ArrowUpIcon : ArrowDownIcon;
}

function glyphClass(t: DccTransfer): string {
  if (t.state === 'queued') return 'muted';
  if (t.state === 'stalled' || (t.state === 'requested' && t.bot_acked_at)) return 'warn';
  if (!ACTIVE_STATES.has(t.state)) return 'bad';
  return 'accent';
}

// ─── Actions ─────────────────────────────────────────────────────────────────

interface RowAction {
  label: string;
  tone?: 'good' | 'bad';
  run: () => void;
}

// Errors land on the row (actionError / fileError) or in the store's own
// error lines; a failed promise needs nothing more here.
function act(p: Promise<unknown>): void {
  openMenu.value = null;
  p.catch(() => {});
}

function rowActions(t: DccTransfer): RowAction[] {
  if (t.state === 'queued')
    return [{ label: 'Remove', tone: 'bad', run: () => act(dcc.cancel(t.id)) }];
  if (t.state === 'offered') {
    return [{ label: 'Withdraw', tone: 'bad', run: () => act(dcc.cancel(t.id)) }];
  }
  if (ACTIVE_STATES.has(t.state) && t.state !== 'stalled') {
    return [{ label: 'Cancel', tone: 'bad', run: () => act(dcc.cancel(t.id)) }];
  }
  const out: RowAction[] = [];
  if (retryable(t)) {
    out.push({ label: 'Retry', run: () => act(dcc.retry(t.id)) });
  }
  if (holdsPartial(t)) {
    out.push({
      label: 'Delete partial',
      tone: 'bad',
      run: () => {
        if (!confirm(`Delete the partial download of "${t.filename}"?`)) return;
        act(dcc.clearTransfer(t.id, true));
      },
    });
  } else {
    out.push({ label: 'Dismiss', run: () => act(dcc.clearTransfer(t.id)) });
  }
  return out;
}

// The networks a file can go out on: those connected now.
const connectedNetworks = computed(() =>
  networks.networks.filter((n) => networks.states[n.id]?.state === 'connected'),
);

// The row whose Send to… is open, and what it holds.
const sendingTo = ref<{ fileId: number; nick: string; networkId: number } | null>(null);

function fileActions(f: DccFile): RowAction[] {
  if (dcc.pick) {
    return [{ label: 'Send', tone: 'good', run: () => act(dcc.sendPicked(f.id)) }];
  }
  const out: RowAction[] = [];
  if (dcc.account?.send && connectedNetworks.value.length) {
    out.push({ label: 'Send to…', run: () => startSendTo(f) });
  }
  out.push({ label: 'Download', run: () => act(dcc.downloadKeptFile(f.id)) });
  out.push({
    label: 'Delete',
    tone: 'bad',
    run: () => {
      // The file is gone for good once deleted.
      if (!confirm(`Delete "${f.name}" from the server?`)) return;
      act(dcc.deleteKeptFile(f.id));
    },
  });
  return out;
}

function startSendTo(f: DccFile) {
  openMenu.value = null;
  // The network of the buffer in view, when it's connected; else the first.
  const active = networks.activeBuffer?.networkId;
  const list = connectedNetworks.value;
  const networkId = list.some((n) => n.id === active) ? active! : list[0].id;
  sendingTo.value = { fileId: f.id, nick: '', networkId };
}

function onSendTo(f: DccFile) {
  const to = sendingTo.value;
  if (!to || !to.nick.trim()) return;
  // Active or passive is the server's call: passive when it can't listen (#1154).
  dcc
    .sendFile(to.networkId, to.nick.trim(), f.id)
    .then(() => {
      sendingTo.value = null;
    })
    .catch(() => {
      /* error surfaced via dcc.fileError */
    });
}

// How a received file checked out (#1082). One with no CRC32 in its name, or
// one resumed, says it wasn't verified rather than saying nothing.
function crcNote(f: DccFile): { text: string; tone: 'good' | 'bad' | null } | null {
  switch (f.crc_status) {
    case 'ok':
      return { text: 'checksum verified', tone: 'good' };
    case 'mismatch':
      return { text: 'checksum mismatch', tone: 'bad' };
    case 'absent':
      return { text: 'not verified (no checksum)', tone: null };
    case 'unverified':
      return { text: 'not verified (resumed)', tone: null };
    default:
      return null;
  }
}

function fileLine(f: DccFile): string {
  return joinMeta([
    f.peer_nick ? `from ${f.peer_nick}` : 'uploaded by you',
    f.peer_nick ? networkName(f.network_id) : '',
    formatBytes(f.size),
    formatRelative(f.created_at),
  ]);
}

// ⋯ on a phone: one row's menu open at a time.
const openMenu = ref<string | null>(null);
function toggleMenu(key: string) {
  openMenu.value = openMenu.value === key ? null : key;
}

// ─── Upload to send ──────────────────────────────────────────────────────────

const uploadInput = ref<HTMLInputElement | null>(null);

function chooseUpload() {
  uploadInput.value?.click();
}

// A file chosen while picking: up it goes, then out to who it was picked for.
// ⚠ That pick, not whatever is picking when the upload ends: a pick cancelled
// meanwhile, or one for someone else, keeps the file and sends nothing.
async function onUploadChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const chosen = input.files?.[0];
  input.value = '';
  if (!chosen) return;
  const pick = dcc.pick;
  try {
    const keptFile = await dcc.uploadFile(chosen);
    if (pick && dcc.pick === pick) await dcc.sendPicked(keptFile.id);
  } catch {
    /* surfaced via dcc.uploadError, or the file's own error */
  }
}
</script>

<style scoped>
.dcc-tab {
  display: flex;
  flex-direction: column;
}
.group {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  color: var(--fg-muted);
  padding: var(--space-6) 0 var(--space-2);
}
.dcc-tab > .group:first-child {
  padding-top: 0;
}
.peer-block + .peer-block {
  margin-top: var(--space-4);
}
.peer-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding-top: var(--space-4);
}
.peer {
  color: var(--fg);
  font-weight: 600;
}
.muted {
  color: var(--fg-muted);
}
.note {
  color: var(--fg-muted);
  margin: 0 0 var(--space-4);
}
.error,
.err {
  color: var(--bad);
}
.error {
  margin: 0 0 var(--space-4);
}
.err {
  margin-top: var(--space-2);
  overflow-wrap: anywhere;
}
.pick {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  margin-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: grid;
  grid-template-columns: max-content 1fr max-content;
  column-gap: var(--space-5);
  align-items: start;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}
.row.dim .name {
  color: var(--fg-muted);
}
.glyph {
  display: flex;
  align-items: center;
  height: 1.55em;
}
.glyph.accent {
  color: var(--accent);
}
.glyph.warn {
  color: var(--warn);
}
.glyph.bad {
  color: var(--bad);
}
.glyph.muted {
  color: var(--fg-muted);
}
.crc.good {
  color: var(--good);
}
.crc.bad {
  color: var(--bad);
}
.meta {
  min-width: 0;
}
.name {
  color: var(--fg);
  overflow-wrap: anywhere;
}
.sub {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.bar-row {
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
  transition: width 0.3s ease;
}
.bar-row .sub {
  flex-shrink: 0;
}
.acts {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.link {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: var(--space-2) var(--space-4);
  white-space: nowrap;
}
.link:hover {
  color: var(--fg);
}
.link:disabled {
  color: var(--fg-muted);
  cursor: default;
}
.link.good {
  color: var(--good);
}
.link.bad {
  color: var(--bad);
}
.link.good:hover:not(:disabled),
.link.bad:hover:not(:disabled) {
  color: var(--fg);
}
.link.inline {
  padding: 0;
}
.more {
  display: none;
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: var(--space-2) var(--space-4);
}
.menu {
  display: none;
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
  max-width: 100%;
}
.empty {
  padding: var(--space-9) 0;
  color: var(--fg-muted);
  text-align: center;
}

/* A phone: a row's actions fold behind ⋯, except where they are the row's
   whole point (an offer, a queued pack, a pick). */
@media (max-width: 640px) {
  .row:not(.inline) > .acts:not(.always) {
    display: none;
  }
  .row:not(.inline) > .more {
    display: block;
  }
  .row > .acts.always + .more {
    display: none;
  }
  .menu {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    grid-column: 2 / 4;
    padding-top: var(--space-2);
  }
  .row.inline {
    grid-template-columns: max-content 1fr;
  }
  .row.inline > .acts {
    grid-column: 2;
    padding-top: var(--space-2);
  }
}
</style>
