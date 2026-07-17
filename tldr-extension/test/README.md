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
npm install        # first time — installs Playwright
npm run setup      # downloads Chromium + vendors the extra libs (no root)
npm run test:e2e
```

### Note on system libraries

Headless Chromium needs a couple of shared libs (`libgbm.so.1`,
`libwayland-server.so.0`) that aren't always installed system-wide. `npm run
setup` handles this **without root**: `setup-libs.sh` uses `apt-get download`
(no root needed) to fetch just those packages and extracts the `.so` files into
a gitignored `_libs/flat/`. `e2e.mjs` auto-detects that directory and puts it on
`LD_LIBRARY_PATH` for the child Chromium process — so `npm run test:e2e` just
works afterward.

If you *do* have root, `npx playwright install-deps chromium` is the standard
alternative and makes `setup-libs.sh` unnecessary.

## What these tests do NOT cover

The Chrome orchestration glue — `chrome.contextMenus`, `chrome.sidePanel.open`,
and cross-context messaging in `background.js` / `panel.js`. Those APIs can't be
driven headlessly and still require a manual load-unpacked click-through.
