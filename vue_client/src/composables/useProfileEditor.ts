// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';

// The profile editor (#1189): which network's profile is open, if any.
const networkId = ref<number | null>(null);

export function useProfileEditor() {
  function open(id: number): void {
    networkId.value = id;
  }
  function close(): void {
    networkId.value = null;
  }
  return { networkId, open, close };
}
