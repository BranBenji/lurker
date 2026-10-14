<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  What DCC does for this account (#1080): where received files land and the
  limits the operator set. The category only exists where the instance runs DCC
  (features.dcc); whether THIS account was granted it comes from
  GET /api/dcc/config. Read-only: every value here is server configuration.
-->

<template>
  <section id="transfers" class="settings-pane">
    <h2>transfers</h2>
    <p class="section-desc">
      With DCC, people on IRC can send you files and open direct chats. Files are received by this
      server, and you download them from the Transfers list.
    </p>

    <template v-if="config">
      <table v-if="config.enabled" class="limits">
        <tbody>
          <tr>
            <th scope="row">Saved to</th>
            <td>
              <code v-if="config.directory">{{ config.directory }}</code>
              <span v-else class="warn">not set — nothing can be received until it is</span>
            </td>
          </tr>
          <tr>
            <th scope="row">Largest file</th>
            <td>{{ config.maxFileBytes ? formatBytes(config.maxFileBytes) : 'no limit' }}</td>
          </tr>
          <tr>
            <th scope="row">Peers on private networks</th>
            <td>{{ config.allowPrivateHosts ? 'allowed' : 'blocked' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="config.enabled" class="muted small">Set in the server's configuration.</p>
      <p v-else class="muted small">
        DCC isn't turned on for your account.
        <template v-if="auth.isAdmin">
          Turn it on in <RouterLink to="/admin/users">Admin → Users</RouterLink>.
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
  enabled: boolean;
  directory?: string | null;
  maxFileBytes?: number;
  allowPrivateHosts?: boolean;
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
code {
  color: var(--fg);
  overflow-wrap: anywhere;
}
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
.warn {
  color: var(--warn);
}
</style>
