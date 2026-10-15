// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router.js';
import './assets/main.css';
import { installVisualViewport } from './composables/useVisualViewport.js';
import { preloadEmoji } from './composables/useEmoji.js';

installVisualViewport();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

// Fetch the emoji table up front (during the initial connect/buffer-load pause)
// so render-time `:shortcode:` parsing has it ready. Render falls back to the
// literal text until it lands, then repaints — see useEmoji.ts.
preloadEmoji();
