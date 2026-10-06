<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → Notifications: the opt-in to push.lurker.chat for the official
  iOS and Android apps (lurker-dev/RELAY_PLAN.md §5a). Until it's on, the server
  doesn't mention the relay to the apps, so they never contact it.
-->

<template>
  <section id="admin-notifications" class="settings-pane">
    <h2>notifications</h2>
    <p v-if="error" class="error inline">{{ error }}</p>

    <template v-if="push">
      <p v-if="!push.vapidSubject.appleAccepts" class="error inline">
        Safari and home-screen web apps on iPhone will refuse notifications from this server. (The
        Lurker apps aren't affected.) Set <code>VAPID_SUBJECT</code> to <code>mailto:</code> an
        address on a real domain, or to your server's <code>https://</code> URL, then restart.
      </p>
      <p v-else-if="push.vapidSubject.ignored" class="muted small">
        <code>VAPID_SUBJECT</code> isn't usable, so web push uses
        <code>{{ push.vapidSubject.subject }}</code> instead.
      </p>
      <p v-if="native" class="section-desc">
        This server sends notifications to browsers and to the Lurker iOS and Android apps directly.
      </p>
      <template v-else>
        <p class="section-desc">
          Browsers get notifications from this server directly. The Lurker iOS and Android apps need
          <a :href="push.relay.url" target="_blank" rel="noopener">{{ relayHost }}</a>
          to forward them. Each notification is encrypted for the phone, so the relay can't read it.
        </p>

        <h3 class="subhead">server key</h3>
        <p class="muted small">Register this key at {{ relayHost }}.</p>
        <div class="key-row">
          <code class="key">{{ push.publicKey }}</code>
          <button class="link" type="button" @click="copy(push.publicKey)">
            {{ copied ? 'copied' : 'copy' }}
          </button>
        </div>
        <p class="relay-status small">
          <span v-if="status" :class="status.ok ? 'muted' : 'error'">{{ status.text }}</span>
          <button class="link" type="button" :disabled="checking" @click="check">
            {{ checking ? 'checking…' : 'check' }}
          </button>
        </p>
      </template>

      <!-- Still shown on a native server while the relay is on: otherwise an
           admin who added APNs/FCM keys later would have no way to turn it off. -->
      <template v-if="!native || push.relay.enabled">
        <label class="check">
          <input type="checkbox" :checked="push.relay.enabled" :disabled="busy" @change="toggle" />
          <span>Use {{ relayHost }} for the iOS and Android apps</span>
        </label>
        <p v-if="push.relay.enabled" class="muted small">
          {{ deviceCount }} registered through the relay. Turning this off removes them.
        </p>
        <p v-else class="muted small">While this is off, the apps never contact {{ relayHost }}.</p>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAdminStore } from '../../stores/admin.js';
import { useCopyFeedback } from '../../composables/useCopyFeedback.js';

const store = useAdminStore();
const { copied, copy } = useCopyFeedback();
const error = ref('');
const busy = ref(false);

const push = computed(() => store.push);
// Both apps already get native push (the hosted service), so the relay has
// nothing to do here.
const native = computed(
  () => !!push.value?.transports.includes('apns') && push.value.transports.includes('fcm'),
);
const relayHost = computed(() => (push.value ? new URL(push.value.relay.url).host : ''));
const deviceCount = computed(() => {
  const n = push.value?.relay.devices ?? 0;
  return n === 1 ? '1 device' : `${n} devices`;
});

const checking = ref(false);

// What push.lurker.chat says about this server's key, in a line.
const status = computed((): { text: string; ok: boolean } | null => {
  const s = push.value?.relay.status;
  if (!s) return null;
  switch (s.state) {
    case 'active':
      if (s.comped) return { text: 'Comped', ok: true };
      if (s.paidThrough) {
        const date = new Date(s.paidThrough).toLocaleDateString(undefined, { dateStyle: 'medium' });
        return { text: `Active — paid through ${date}`, ok: true };
      }
      return { text: 'Active', ok: true };
    case 'inactive':
      return s.registered
        ? { text: "This server's key isn't active on " + relayHost.value, ok: false }
        : { text: relayHost.value + " doesn't recognize this server's key", ok: false };
    case 'unauthorized':
      return { text: relayHost.value + " couldn't verify this server's key", ok: false };
    case 'unreachable':
      return { text: "Couldn't reach " + relayHost.value, ok: false };
  }
});

async function check() {
  error.value = '';
  checking.value = true;
  try {
    await store.checkPushRelay();
  } catch (e: any) {
    error.value = e.message || 'failed to check';
  } finally {
    checking.value = false;
  }
}

async function load() {
  error.value = '';
  try {
    await store.fetchPush();
  } catch (e: any) {
    error.value = e.message || 'failed to load notification settings';
  }
}

// The checkbox flips itself before we know whether the change will stick, and
// Vue won't put it back: the bound value never changed. So a cancelled or
// failed change resets the input by hand.
async function toggle(e: Event) {
  const input = e.target as HTMLInputElement;
  const enabled = input.checked;
  if (
    !enabled &&
    (push.value?.relay.devices ?? 0) > 0 &&
    !confirm(`Turn off the relay? ${deviceCount.value} will stop getting notifications.`)
  ) {
    input.checked = true;
    return;
  }
  error.value = '';
  busy.value = true;
  try {
    await store.setPushRelayEnabled(enabled);
  } catch (e: any) {
    // The store refetched; show what the server holds.
    input.checked = store.push?.relay.enabled ?? !enabled;
    error.value = e.message || 'failed to change the relay setting';
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.key-row {
  display: flex;
  align-items: center;
  gap: 1ch;
  margin-bottom: var(--space-6);
}
.key {
  flex: 1 1 auto;
  font-family: var(--mono);
  word-break: break-all;
  user-select: all;
  background: var(--bg);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border);
  min-width: 0;
}
.relay-status {
  display: flex;
  gap: 1ch;
  margin-top: calc(-1 * var(--space-4));
  margin-bottom: var(--space-6);
}
.check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
}
.check input {
  width: auto;
}
</style>
