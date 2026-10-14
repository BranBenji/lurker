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
                @change="toggle(u, part)"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">
        Turning one off stops what starts next. Anything already running finishes, and files already
        received stay theirs to download.
      </p>
    </template>
    <p v-else-if="!error" class="muted small">Loading…</p>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../../api.js';
import { formatBytes } from '../../utils/formatBytes.js';

type Part = 'chat' | 'receive';
const PARTS: readonly Part[] = ['chat', 'receive'];

interface DccUser {
  id: number;
  username: string;
  chat: boolean;
  receive: boolean;
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

async function toggle(u: DccUser, part: Part) {
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
</style>
