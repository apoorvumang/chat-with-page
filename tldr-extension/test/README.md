# Tests

Two levels, both exercising the real `content.js` — the extraction, node-map,
sentence-snap, and offset round-trip logic where all the tricky behavior lives.

## `roundtrip.test.cjs` — pure unit test (no browser)

Asserts the offset math on a synthetic extraction + node map: exact source
slices, heading-with-no-period resolution (the block-separator gap bug), and
raw-offset mapping into the correct node.

```bash
npm run test:unit
```

## `e2e.mjs` — live-site integration test (headless Chromium)

Loads real pages, injects `content.js` behind a minimal `chrome` shim (the same
way the extension runs it — in a CSP-exempt isolated world), then drives the
exact message flow the extension uses: set a selection → dispatch `contextmenu`
→ `capture-selection` → `highlight`, and reads back `CSS.highlights` to confirm
the correct span was highlighted.

Covers two regressions:
- **single-text-node selections** extract text (the x.com failure).
- **every attribution highlight resolves**, including headings / nav links.

```bash
npm install        # first time — downloads Playwright
npx playwright install chromium
npm run test:e2e
```

### Note on system libraries

Headless Chromium needs a few shared libs. On a minimal box you may hit
`libgbm.so.1: cannot open shared object file`. With root:
`npx playwright install-deps chromium`. Without root, fetch just the missing
libs and point `LD_LIBRARY_PATH` at them:

```bash
apt-get download libgbm1 libwayland-server0   # no root needed
for d in *.deb; do dpkg-deb -x "$d" ./_libs; done
LD_LIBRARY_PATH="$PWD/_libs/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH" npm run test:e2e
```

## What these tests do NOT cover

The Chrome orchestration glue — `chrome.contextMenus`, `chrome.sidePanel.open`,
and cross-context messaging in `background.js` / `panel.js`. Those APIs can't be
driven headlessly and still require a manual load-unpacked click-through.
