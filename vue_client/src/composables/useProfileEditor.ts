// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';
import { ownMetadataRefusal } from '../lib/commands/metadata.js';
import { useNetworksStore } from '../stores/networks.js';

// The profile editor (#1189): which network's profile is open, if any.
const networkId = ref<number | null>(null);

export function useProfileEditor() {
  const networks = useNetworksStore();
  // Only where a profile can go now: connected, to a network that carries
  // metadata. One kept for a network that can't would never be set.
  function canOpen(id: number): boolean {
    return !ownMetadataRefusal(networks.states[id]);
  }
  function open(id: number): void {
    networkId.value = id;
  }
  function close(): void {
    networkId.value = null;
  }
  return { networkId, canOpen, open, close };
}
