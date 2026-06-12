# Vendored renderer libraries

These are checked-in, not pulled at build time, so the WebView renders offline
with no network surface. Licenses are in `THIRD_PARTY_NOTICES.md`. The renderer
that consumes them is `assets/thread/thread.js` plus `ThreadRenderer.kt`.

To refresh a library, re-pull the pinned version and bump the note here:

```bash
curl -fsSL -o markdown-it.min.js   https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js
curl -fsSL -o highlight.min.js     https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js
curl -fsSL -o hljs-github.min.css  https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github.min.css
curl -fsSL -o hljs-github-dark.min.css https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github-dark.min.css
curl -fsSL -o mermaid.min.js       https://cdn.jsdelivr.net/npm/mermaid@10.9.3/dist/mermaid.min.js
```

The highlight.js build above is the full bundle. If APK size becomes a concern,
swap it for a custom build limited to the languages `thread.js` highlights
(kotlin, typescript, javascript, bash, json, diff).
