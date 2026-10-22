# Avatar tile sets

`default/` is the bundled set behind generated avatars (#607): one tile per
nick, chosen by `shared/avatarTiles.ts` (a salted hash of the nick, the same
trim the nick colour uses), drawn over the nick's colour. A metadata avatar
replaces the tile where a network carries one.

Layout, read by the web client and the apps:

- `000.webp` … `NNN.webp` — square, 256×256, WebP with alpha, numbered in
  file-name order from 000
- `manifest.json` — `{ "count": N, "ext": "webp" }`

Built by `tools/build-avatar-set.mjs`:

```
node tools/build-avatar-set.mjs <folder-of-images> vue_client/public/avatars/default
```

The current tiles are a placeholder (`--placeholder`), geometric shapes in
black and off-white, until the real set lands. Set authors own contrast
against the nick palette; the theme doesn't correct it.
