<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  What DCC does for this account (#1080): which parts an admin granted (chat,
  receiving files, sending them (#1086)), and, for files, the limits the
  operator set. Where files
  land on the server is the admin's business (Admin → DCC), not shown here. The
  category only exists where the instance runs DCC (features.dcc); the grants
  come from GET /api/dcc/config. Read-only.
-->

<template>
  <section id="dcc" class="settings-pane">
    <h2>dcc</h2>
    <p class="section-desc">
      With DCC, people on IRC can open direct chats with you and swap files with you. Files are kept
      on this server, in the DCC window.
    </p>

    <template v-if="config">
      <template v-if="config.chat || config.receive || config.send">
        <table class="limits">
          <tbody>
            <tr>
              <th scope="row">Chats</th>
              <td>{{ config.chat ? 'on' : 'off' }}</td>
            </tr>
            <tr>
              <th scope="row">Receiving files</th>
              <td>{{ config.receive ? 'on' : 'off' }}</td>
            </tr>
            <tr>
              <th scope="row">Sending files</th>
              <td>
                {{ config.send ? 'on' : 'off' }}
                <span v-if="config.send && !config.canListen" class="muted">
                  — passive only: this server has no public address set up for DCC
                </span>
              </td>
            </tr>
            <template v-if="config.receive || config.send">
              <tr>
                <th scope="row">Space used</th>
                <td>
                  {{ formatBytes(config.usedBytes ?? 0) }}
                  <template v-if="config.limitBytes != null">
                    of {{ formatBytes(config.limitBytes) }}
                  </template>
                  <span v-else class="muted">— no limit</span>
                </td>
              </tr>
              <tr>
                <th scope="row">Largest file</th>
                <td v-if="config.maxFileBytes">
                  {{ formatBytes(config.maxFileBytes) }}
                  <span class="muted">— offers that don't say their size are refused</span>
                </td>
                <td v-else>no limit</td>
              </tr>
              <tr>
                <th scope="row">Peers on private networks</th>
                <td>{{ config.allowPrivateHosts ? 'allowed' : 'blocked' }}</td>
              </tr>
            </template>
          </tbody>
        </table>
        <p class="muted small">
          Set by an admin and the server's configuration.
          <RouterLink v-if="auth.isAdmin" to="/admin/dcc">Admin → DCC</RouterLink>
        </p>
      </template>
      <p v-else class="muted small">
        DCC isn't turned on for your account.
        <template v-if="auth.isAdmin">
          Turn it on in <RouterLink to="/admin/dcc">Admin → DCC</RouterLink>.
        </template>
        <template v-else>An admin can turn it on.</template>
      </p>
    </template>
    <p v-else-if="error" class="muted small">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../../api.js';
import { useAuthStore } from '../../stores/auth.js';
import { formatBytes } from '../../utils/formatBytes.js';

interface DccConfig {
  chat: boolean;
  receive: boolean;
  send: boolean;
  canListen?: boolean;
  maxFileBytes?: number;
  allowPrivateHosts?: boolean;
  usedBytes?: number;
  limitBytes?: number | null;
}

const auth = useAuthStore();
const config = ref<DccConfig | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    config.value = await api<DccConfig>('/api/dcc/config');
  } catch (e: any) {
    error.value = e?.message || 'couldn’t read the DCC settings — reload the page';
  }
});
</script>

<style src="./panes.css"></style>
<style scoped>
.limits {
  margin: var(--space-6) 0;
  border-collapse: collapse;
}
.limits th,
.limits td {
  padding: var(--space-1) var(--space-6) var(--space-1) 0;
  text-align: left;
  font-weight: normal;
  vertical-align: top;
}
.limits th {
  color: var(--fg-muted);
}
</style>
