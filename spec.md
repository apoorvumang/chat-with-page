# Spec: "TLDR" Chrome Extension — Chat with Selected Page Content + Source Attribution

## Goal

Chrome extension (Manifest V3). User selects text on any web page → right-clicks → "TLDR" context menu item → a side panel opens with a chat scoped to the selected content. LLM answers are attributed back to the source via TokenPath (token-level attribution API), and clicking an attributed claim highlights + scrolls to the exact span in the live page.

## User flow

1. User selects text on a page.
2. Right-click → context menu item "TLDR" (context: `selection`).
3. Side panel opens (`chrome.sidePanel`), showing a chat UI seeded with the extracted selection text.
4. User asks questions / requests summary. Responses come from an LLM + TokenPath attribution (integration point stubbed — the owner will wire the actual endpoint).
5. Attributed spans in the answer are clickable. Clicking one sends the char-offset range to the content script, which highlights the corresponding text in the page (CSS Custom Highlight API) and scrolls it into view.

## Architecture

### Components

- **`manifest.json`** — MV3. Permissions: `contextMenus`, `sidePanel`, `activeTab`, `scripting`, `storage`. Content script injected on all pages (or on-demand via `scripting.executeScript` with `activeTab` — preferred for privacy).
- **`background.js`** (service worker) — creates the context menu on install; on menu click, opens the side panel for that tab and messages the content script to capture the selection.
- **`content.js`** — selection capture, text extraction + node map construction, highlighting.
- **`sidepanel/`** (`panel.html`, `panel.js`, `panel.css`) — chat UI. Talks to the LLM/TokenPath API and exchanges messages with the content script via the background worker or `chrome.tabs.sendMessage`.

### Critical design decision: the node map never leaves the content script

DOM nodes can't be serialized across the extension message boundary. So:

- Content script builds and **retains** the map: `[{ start, end, node }]` (char offsets into the extracted text → live Text nodes).
- Side panel only ever receives `{ text: string }` and only ever sends back `{ highlight: { start, end } }` char offsets.
- Content script resolves offsets → nodes via binary search, builds a `Range`, highlights.

### Selection capture (timing gotcha)

The context-menu click callback (`chrome.contextMenus.onClicked`) only provides `info.selectionText` — flattened text, **no node info**. So the content script must snapshot the live selection itself:

- On `contextmenu` event in the content script, store `window.getSelection().getRangeAt(0).cloneRange()` in a module-level variable.
- When the "capture selection" message arrives after menu click, extract from that stored Range (the visible selection may have collapsed by then; the cloned Range stays valid as long as the DOM hasn't changed).

### Text extraction + node map (from the stored Range)

- Use a `TreeWalker` with `NodeFilter.SHOW_TEXT` over `range.commonAncestorContainer`.
- For each text node: skip if not intersecting the Range (`range.intersectsNode(n)`) or if invisible (check `parentElement` computed style: `display:none`, `visibility:hidden`, zero-size; also skip `script`/`style`/`noscript`).
- Handle partial boundary nodes: for the first/last text node, slice by `range.startOffset` / `range.endOffset` and record the node-internal offset in the map entry (`nodeStartOffset`).
- Concatenate node text into the canonical extraction string; append `"\n"` between block-level boundaries (check if parent is block-level) so the LLM sees paragraph structure.
- Map entry: `{ start, end, node, nodeStartOffset }` where `start`/`end` are offsets in the extraction string.

### Whitespace normalization (important)

Attribution offsets must refer to the **exact extraction string**. Pick one canonical normalization (e.g., collapse runs of whitespace to single space per text node, as the browser renders it) and apply it **at extraction time only** — the map must be built against the normalized text so offsets round-trip exactly. Do not re-normalize later on the answer side.

### Highlighting

- Use the **CSS Custom Highlight API** (`CSS.highlights`, `new Highlight(range)`) — supported in Chrome, no DOM mutation, so the node map stays valid across repeated highlights.
- Register a highlight name (e.g., `tldr-attrib`) and style via `::highlight(tldr-attrib)` injected in a content-script stylesheet.
- On a highlight request `{ start, end }`:
  1. Binary search the map for entries overlapping `[start, end)`.
  2. Build a `Range` spanning from the first node (offset `start - entry.start + nodeStartOffset`) to the last node (analogous end offset).
  3. Clear previous highlight, set new one, `range.startContainer.parentElement.scrollIntoView({ behavior: "smooth", block: "center" })`.
- **Snap to sentence/paragraph**: token-level attribution spans are noisy. Before highlighting, snap the char range outward to sentence boundaries (regex on the extraction string) or to the enclosing map entries' block element. Sentence-snap is the default UX.

### Side panel chat

- Minimal chat UI: message list, input box, send button. No framework needed (vanilla JS fine) — keep it simple for v0.
- Seeded context: the extracted selection text (received once when the panel opens, keyed by tab ID).
- **LLM + TokenPath integration is a stub**: a single `async function askLLM(context, messages)` returning `{ answer: string, attributions: [{ answerStart, answerEnd, sourceStart, sourceEnd }] }`. Owner will implement against the real TokenPath API. Build the UI to render `attributions` as clickable spans within the answer text.
- Clicking an attributed span → `chrome.tabs.sendMessage(tabId, { type: "highlight", start: sourceStart, end: sourceEnd })`.

### Message protocol (suggested)

| From → To | Type | Payload |
|---|---|---|
| background → content | `capture-selection` | — |
| content → sidepanel (via background or `runtime.sendMessage`) | `selection-captured` | `{ tabId, text }` |
| sidepanel → content | `highlight` | `{ start, end }` |
| sidepanel → content | `clear-highlight` | — |

Side panel must track which tab it belongs to (`chrome.tabs.query` or passed from background at open time) and handle the tab navigating away (map invalidated → disable highlight buttons, show a notice).

## Edge cases / known gotchas

- **Selection lost before capture**: handled by the `contextmenu`-event Range snapshot (above).
- **DOM mutation after extraction** (SPAs, virtualized lists): stored nodes may be detached. On highlight, check `node.isConnected`; if detached, fall back to text search (`window.find`-style or manual walk for the span string) and warn if not found.
- **Cross-boundary selections** (selection spanning into iframes / shadow DOM): out of scope for v0 — extract only from the main document; note the limitation.
- **Repeated text**: not an issue in Option A (offset-based, not search-based) as long as nodes stay connected.
- **Side panel opening steals focus** and collapses the visual selection — cosmetic only; the cloned Range still works.
- **`chrome.sidePanel.open()` must be called in the user-gesture context** of the menu click handler (it throws otherwise).

## Deliverables

```
tldr-extension/
├── manifest.json
├── background.js
├── content.js
├── content.css          # ::highlight() styles
└── sidepanel/
    ├── panel.html
    ├── panel.js
    └── panel.css
```

Working end-to-end with the stubbed `askLLM` (stub can return a fake summary with fake attributions covering, e.g., the first sentence of each paragraph, so the highlight round-trip is demonstrable without API keys).

## Non-goals (v0)

- Full-page extraction / Readability-style article mode (selection-only for now).
- iframe / shadow DOM support.
- Streaming responses.
- Persistence of chats.
