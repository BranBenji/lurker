<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → DCC (#1080, #1125). The instance's DCC settings, and per user:
  which parts of DCC they may use (chat, and receiving files, granted separately
  so an admin can allow direct chats without letting files land on the box), a
  storage limit, and what their received files take now. Every part also needs
  LURKER_DCC_ENABLED. With it off the grants still list, so an admin can clear
  them before turning DCC back on.

  The table is read-only. "edit" opens one editor under that row with all three
  settings and one save, so there is a single way to change anything and a
  single confirmation that it saved; the table's columns never move.
-->

<template>
  <section id="admin-dcc" class="settings-pane">
    <h2>dcc</h2>
    <p class="section-desc">
      Direct connections between people on IRC: chats, and files sent to this server.
    </p>
    <p v-if="loadError" class="error inline">{{ loadError }}</p>

    <template v-if="info">
      <p v-if="!info.enabled" class="muted small">
        DCC is off for this instance. Set <code>LURKER_DCC_ENABLED</code> to turn it on; until then
        the settings below do nothing.
      </p>
      <table v-else class="facts">
        <tbody>
          <tr>
            <th scope="row">Files saved under</th>
            <td>
              <code v-if="info.directory">{{ info.directory }}</code>
              <span v-else class="warn">
                not set — set <code>LURKER_DCC_DIR</code>, or nothing can be received
              </span>
            </td>
          </tr>
          <tr>
            <th scope="row">Largest file</th>
            <td>{{ info.maxFileBytes ? formatBytes(info.maxFileBytes) : 'no limit' }}</td>
          </tr>
          <tr>
            <th scope="row">Peers on private networks</th>
            <td>{{ info.allowPrivateHosts ? 'allowed' : 'blocked' }}</td>
          </tr>
          <tr>
            <th scope="row">Free-disk floor</th>
            <td>{{ formatBytes(info.freeDiskFloorBytes) }}</td>
          </tr>
        </tbody>
      </table>

      <table class="users">
        <thead>
          <tr>
            <th scope="col">user</th>
            <th scope="col">chat</th>
            <th scope="col">receive</th>
            <th scope="col">limit</th>
            <th scope="col">used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="u in info.users" :key="u.id">
            <tr :class="{ open: editing?.id === u.id }">
              <th scope="row">{{ u.username }}</th>
              <td>{{ u.chat ? 'on' : '—' }}</td>
              <td>{{ u.receive ? 'on' : '—' }}</td>
              <td>{{ u.limitBytes === null ? 'none' : formatBytes(u.limitBytes) }}</td>
              <td>{{ u.usedBytes ? formatBytes(u.usedBytes) : '—' }}</td>
              <td class="act">
                <span v-if="savedFor === u.id" class="muted" role="status">saved</span>
                <button
                  v-else-if="editing?.id !== u.id"
                  class="link"
                  :disabled="busy"
                  @click="startEdit(u)"
                >
                  edit
                </button>
              </td>
            </tr>
            <tr v-if="editing?.id === u.id" class="editor">
              <td colspan="6">
                <form @submit.prevent="save(u)">
                  <!-- With DCC off for the instance, a part can be taken away
                       but not given. -->
                  <label>
                    <input
                      v-model="editing.chat"
                      type="checkbox"
                      :disabled="busy || (!info.enabled && !u.chat)"
                    />
                    chat
                  </label>
                  <label>
                    <input
                      v-model="editing.receive"
                      type="checkbox"
                      :disabled="busy || (!info.enabled && !u.receive)"
                    />
                    receive files
                  </label>
                  <label>
                    limit
                    <input
                      v-model="editing.limit"
                      class="limit"
                      type="number"
                      step="any"
                      placeholder="none"
                      :disabled="busy"
                    />
                    GB
                  </label>
                  <span class="muted small">blank for no limit</span>
                  <span class="buttons">
                    <button type="submit" class="link" :disabled="busy">save</button>
                    <button type="button" class="link" :disabled="busy" @click="editing = null">
                      cancel
                    </button>
                  </span>
                </form>
                <p v-if="editError" class="error inline">{{ editError }}</p>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p class="muted small">
        Turning a part off stops what starts next. Anything already running finishes, and files
        already received stay theirs to download.
      </p>
      <p class="muted small">
        A limit caps what a user's received files take on disk. A transfer that would go over it is
        refused; nothing is deleted. Users delete their own files in the Transfers list.
      </p>
    </template>
    <p v-else-if="!loadError" class="muted small">Loading…</p>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../../api.js';
import { formatBytes } from '../../utils/formatBytes.js';

interface DccUser {
  id: number;
  username: string;
  chat: boolean;
  receive: boolean;
  /** Null for no limit (#1125). */
  limitBytes: number | null;
  usedBytes: number;
}
interface DccInfo {
  enabled: boolean;
  directory: string | null;
  maxFileBytes: number;
  allowPrivateHosts: boolean;
  freeDiskFloorBytes: number;
  users: DccUser[];
}

const GB = 1024 * 1024 * 1024;

const info = ref<DccInfo | null>(null);
const loadError = ref('');
const busy = ref(false);
// The one row being edited, and what its editor holds. `limit` is in GB, ''
// for none.
const editing = ref<{ id: number; chat: boolean; receive: boolean; limit: string } | null>(null);
const editError = ref('');
// The row that just saved, for a moment of "saved".
const savedFor = ref<number | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

onMounted(async () => {
  try {
    info.value = await api<DccInfo>('/api/admin/dcc');
  } catch (e: any) {
    loadError.value = e?.message || 'failed to load DCC settings';
  }
});
onUnmounted(() => clearTimeout(savedTimer));

// Enough precision that a small limit never reads as 0.
function limitGb(bytes: number | null): string {
  return bytes === null ? '' : String(Number((bytes / GB).toPrecision(6)));
}

function startEdit(u: DccUser) {
  editError.value = '';
  savedFor.value = null;
  editing.value = { id: u.id, chat: u.chat, receive: u.receive, limit: limitGb(u.limitBytes) };
}

async function save(u: DccUser) {
  const draft = editing.value;
  if (!draft) return;
  // v-model on a number input hands back a number, or '' when it's empty.
  const raw = String(draft.limit).trim();
  const gb = Number(raw);
  if (raw !== '' && !(Number.isFinite(gb) && gb > 0)) {
    editError.value = 'a limit is a number of GB above 0, or blank for none';
    return;
  }
  editError.value = '';
  busy.value = true;
  try {
    const next = await api<{ chat: boolean; receive: boolean; limitBytes: number | null }>(
      `/api/admin/dcc/users/${u.id}`,
      {
        method: 'PUT',
        body: {
          chat: draft.chat,
          receive: draft.receive,
          limitBytes: raw === '' ? null : Math.max(1, Math.round(gb * GB)),
        },
      },
    );
    u.chat = next.chat;
    u.receive = next.receive;
    u.limitBytes = next.limitBytes;
    editing.value = null;
    savedFor.value = u.id;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      if (savedFor.value === u.id) savedFor.value = null;
    }, 2000);
  } catch (e: any) {
    // The editor stays open with what was typed: nothing changed.
    editError.value = e?.message || 'failed to save';
  } finally {
    busy.value = false;
  }
}
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
code {
  color: var(--fg);
  overflow-wrap: anywhere;
}
.facts,
.users {
  margin: var(--space-6) 0;
  border-collapse: collapse;
}
.facts th,
.facts td,
.users th,
.users td {
  text-align: left;
  font-weight: normal;
  vertical-align: top;
}
.facts th,
.facts td {
  padding: var(--space-1) var(--space-6) var(--space-1) 0;
}
.facts th,
.users thead th {
  color: var(--fg-muted);
}
/* Rows separated like the Users list (panes.css .device): a line between
   entries, the same padding, the same hover. */
.users {
  width: 100%;
}
.users th,
.users td {
  padding: var(--space-3) var(--space-6) var(--space-3) 0;
}
.users thead th {
  border-bottom: 1px solid var(--border);
}
.users tbody tr + tr {
  border-top: 1px solid var(--border);
}
.users tbody tr:not(.editor):hover {
  background: var(--bg-soft);
}
.users tbody th {
  color: var(--fg);
}
/* Wide enough for "edit" or "saved", so swapping them never moves a column;
   at the right edge, where the Users list keeps its actions. */
.users .act {
  min-width: 4em;
  padding-right: 0;
  text-align: right;
}
.users .act .link {
  padding: 0;
}
.users tr.open th,
.users tr.open td {
  color: var(--accent);
}
/* The editor belongs to the row above it: no line between them. */
.users tbody tr.editor {
  border-top: none;
}
.editor td {
  padding: 0 0 var(--space-4) var(--space-6);
  border-left: 2px solid var(--accent);
}
.editor form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-6);
}
.editor label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.editor .limit {
  width: 6em;
}
.editor .buttons {
  display: inline-flex;
  gap: var(--space-2);
}
.warn {
  color: var(--warn);
}
</style>
