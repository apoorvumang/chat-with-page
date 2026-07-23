# Tests

The suite has pure/unit coverage for offset math, summary policy, and background
capture orchestration, plus Playwright integration coverage for the side panel
and real content script.

## Unit suite

```bash
npm run test:unit
```

This runs three files:

- **`roundtrip.test.cjs`** checks canonical extraction offsets against raw DOM
  offsets, including synthetic block separators, headings, and exact
  sub-sentence ranges without sentence expansion.
- **`panel-logic.test.cjs`** checks the 24-word automatic-summary cutoff,
  adaptive word and token budgets, the deterministic “TL;DR is shorter” guard,
  code-point-safe truncation around emoji, TokenPath code-point to browser
  UTF-16 offset conversion, and whitespace-free CJK handling.
- **`background.test.cjs`** holds `chrome.sidePanel.open()` unresolved and proves
  that capture still proceeds immediately. It also verifies exact-frame warm
  injection, retries for missing receivers and stale “page changed” responses,
  Gmail or nested-frame routing, click-order race handling, and seed metadata.

## Browser integration

```bash
npm install        # first run
npm run setup      # install Chromium and any vendored Linux libraries
npm run test:e2e
```

`e2e.mjs` loads representative fixtures and public pages, injects the real
scripts behind a small Chrome API shim, and drives selection → `contextmenu` →
capture → fixed-span click or source-offset highlight. It covers:

- side-panel bootstrap while `/credits` never resolves, adaptive summary
  payloads, fixed server-span rendering, code-point offset conversion across a
  LinkedIn-shaped emoji, stale-seed rejection, and routing a click to the
  original tab and frame;
- a Gmail-shaped nested scroll pane whose complete message subtree is replaced
  between capture and highlight, including repeated text and inline elements;
- a WhatsApp-shaped selection spanning link-preview text and a later image
  caption beneath a non-selectable app shell, including metadata exclusion,
  subtree replacement, unrelated message hydration, exact serialized-message
  recovery despite duplicate captions, changed-target rejection, and selection
  cleanup;
- a dynamic SSR article whose subtree hydrates after capture, including an
  unrelated lead edit, a duplicate target outside the article, and exact
  clicked-span recovery beneath the article heading;
- generalized semantic-scope recovery across split and merged text nodes,
  inserted or removed wrappers that change synthetic block separators,
  DOM Ranges that omit those generated separators, and same-node edits outside
  the clicked span;
- repeated target text reordered within one article, including quote-context
  disambiguation from context outside a whole-node selection, rejection of
  indistinguishable candidates, rejection of mutations inside the actual
  target (including ZWJ removal), and no fallback jump to a surviving duplicate
  when the originally attributed occurrence changes;
- duplicated generic element IDs falling back to page-level contextual
  disambiguation instead of trusting the first invalid-ID match;
- rejection after query/hash route identity changes;
- exact Range capture when Chrome's flattened selection hint omits an invisible
  character, followed by clearing the native page selection without losing
  fixed-span highlighting;
- a Substack-shaped late-injection selection spanning header and body, including
  CSS-uppercase dates, `user-select:none` reaction controls, and a visibly
  rendered `aria-hidden` ancestor;
- current X Article DraftJS selectors and blocks, repeated text, and a full
  article subtree rerender;
- X post identity across detach and reorder when another post contains the same
  text, plus rejection of a connected React Text node whose contents changed;
- a live public X post body, including a React-rendered span replacement; and
- single-node and multi-block extraction and highlighting on Example,
  Wikipedia, GNU, MDN, Hacker News, the live FLUX 3 article, a live Substack
  post, and a live X profile.

To run both levels:

```bash
npm test
```

## Linux browser dependencies

Headless Chromium may need `libgbm.so.1` and `libwayland-server.so.0`.
`setup-libs.sh` downloads and extracts them without root into `_libs/flat/`, and
`e2e.mjs` adds that directory to `LD_LIBRARY_PATH`. If system installation is
available, `npx playwright install-deps chromium` is the standard alternative.

## Still manual

The tests mock rather than launch a packaged Chrome extension, so a final
load-unpacked pass should verify the real context menu, side panel, TokenPath
HTTP and authentication flow, clickable fixed attribution spans, nested Gmail
scrolling, and detached-DOM unique remapping. Restricted pages such as
`chrome://` remain unavailable to content scripts by design.

Deterministic fixture failures set a nonzero exit code. Public-site smoke checks
remain diagnostic because network availability and third-party markup can
change independently of the extension.
