<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → DCC (#1080). The instance's DCC settings, and which parts of DCC
  each account may use: chat, and receiving files, granted separately so an
  admin can allow direct chats without letting files land on the box. Every
  part also needs LURKER_DCC_ENABLED. With it off the grants still list, so an
  admin can clear them before turning DCC back on.
-->

<template>
  <section id="admin-dcc" class="settings-pane">
    <h2>dcc</h2>
    <p class="section-desc">
      Direct connections between people on IRC: chats, and files sent to this server.
    </p>
    <p v-if="error" class="error inline">{{ error }}</p>

    <template v-if="info">
      <p v-if="!info.enabled" class="muted small">
        DCC is off for this instance. Set <code>LURKER_DCC_ENABLED</code> to turn it on; until then
        the grants below do nothing.
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

      <table class="grants">
        <thead>
          <tr>
            <th scope="col">user</th>
            <th scope="col">chat</th>
            <th scope="col">receive</th>
            <th scope="col">limit</th>
            <th scope="col">used</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in info.users" :key="u.id">
            <th scope="row">{{ u.username }}</th>
            <td v-for="part in PARTS" :key="part">
              <!-- With DCC off for the instance, a grant can still be cleared
                   but not given. -->
              <input
                type="checkbox"
                :checked="u[part]"
                :disabled="busy || (!info.enabled && !u[part])"
                :aria-label="`${part} for ${u.username}`"
                @change="toggle(u, part, $event)"
              />
            </td>
            <td>
              <!-- In GB; blank is no limit. Nothing saves on its own: "save"
                   (or Enter) appears once the value differs from what's
                   stored, and "saved" confirms it landed. -->
              <form class="limit-form" @submit.prevent="saveLimit(u)">
                <input
                  class="limit"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="none"
                  :value="draftFor(u)"
                  :disabled="busy"
                  :aria-label="`storage limit in GB for ${u.username}`"
                  @input="onDraft(u, $event)"
                />
                GB
                <button v-if="isDirty(u)" type="submit" class="link" :disabled="busy">save</button>
                <span v-else-if="savedFor === u.id" class="muted" role="status">saved</span>
              </form>
            </td>
            <td>{{ u.usedBytes ? formatBytes(u.usedBytes) : '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">
        Turning one off stops what starts next. Anything already running finishes, and files already
        received stay theirs to download.
      </p>
      <p class="muted small">
        A limit caps what a user's received files take on disk. A transfer that would go over it is
        refused; nothing is deleted. Users can delete their own files in the Transfers list.
      </p>
    </template>
    <p v-else-if="!error" class="muted small">Loading…</p>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../../api.js';
import { formatBytes } from '../../utils/formatBytes.js';

type Part = 'chat' | 'receive';
const PARTS: readonly Part[] = ['chat', 'receive'];

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

const info = ref<DccInfo | null>(null);
const error = ref('');
const busy = ref(false);

onMounted(async () => {
  try {
    info.value = await api<DccInfo>('/api/admin/dcc');
  } catch (e: any) {
    error.value = e?.message || 'failed to load DCC settings';
  }
});

const GB = 1024 * 1024 * 1024;

function limitGb(u: DccUser): string {
  return u.limitBytes === null ? '' : String(Math.round((u.limitBytes / GB) * 100) / 100);
}

// What the admin has typed but not saved, per user. Absent means the field
// shows what's stored.
const drafts = ref<Record<number, string>>({});
// The row that just saved, for a moment of "saved".
const savedFor = ref<number | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

function draftFor(u: DccUser): string {
  return drafts.value[u.id] ?? limitGb(u);
}

function onDraft(u: DccUser, event: Event) {
  drafts.value[u.id] = (event.target as HTMLInputElement).value;
  if (savedFor.value === u.id) savedFor.value = null;
}

function isDirty(u: DccUser): boolean {
  const draft = drafts.value[u.id];
  return draft !== undefined && draft.trim() !== limitGb(u);
}

onUnmounted(() => clearTimeout(savedTimer));

async function saveLimit(u: DccUser) {
  if (!isDirty(u)) return;
  const raw = drafts.value[u.id].trim();
  const gb = Number(raw);
  if (raw !== '' && !(Number.isFinite(gb) && gb > 0)) {
    // Kept as typed, so it can be fixed rather than retyped.
    error.value = 'a limit is a number of GB above 0, or blank for none';
    return;
  }
  error.value = '';
  busy.value = true;
  try {
    const next = await api<{ limitBytes: number | null }>(`/api/admin/dcc/users/${u.id}`, {
      method: 'PUT',
      body: { limitBytes: raw === '' ? null : Math.max(1, Math.round(gb * GB)) },
    });
    u.limitBytes = next.limitBytes;
    delete drafts.value[u.id];
    savedFor.value = u.id;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      if (savedFor.value === u.id) savedFor.value = null;
    }, 2000);
  } catch (e: any) {
    // The draft stays, with "save" still showing: nothing changed.
    error.value = e?.message || 'failed to set the limit';
  } finally {
    busy.value = false;
  }
}

async function toggle(u: DccUser, part: Part, event: Event) {
  const box = event.target as HTMLInputElement;
  error.value = '';
  busy.value = true;
  try {
    const next = await api<{ chat: boolean; receive: boolean }>(`/api/admin/dcc/users/${u.id}`, {
      method: 'PUT',
      body: { [part]: !u[part] },
    });
    u.chat = next.chat;
    u.receive = next.receive;
  } catch (e: any) {
    // The box flipped itself on click; nothing changed, so flip it back.
    box.checked = u[part];
    error.value = e?.message || 'failed to change DCC';
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
.grants {
  margin: var(--space-6) 0;
  border-collapse: collapse;
}
.facts th,
.facts td,
.grants th,
.grants td {
  padding: var(--space-1) var(--space-6) var(--space-1) 0;
  text-align: left;
  font-weight: normal;
  vertical-align: top;
}
.facts th,
.grants thead th {
  color: var(--fg-muted);
}
.grants tbody th {
  color: var(--fg);
}
.warn {
  color: var(--warn);
}
.limit-form {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.limit {
  width: 6em;
}
</style>
