# Spec: TLDR Chrome Extension

## Goal

TLDR is a Chrome Manifest V3 extension. A user selects text in a page, chooses
**TLDR** from the context menu, and receives a side-panel chat grounded in that
selection. TokenPath returns attributed spans with each answer. Clicking an
attributed claim highlights and scrolls to its exact source range in the live
page.

## User flow

1. Select text in a page or nested frame and choose **TLDR**.
2. The panel displays the captured text immediately, independently of API-key
   validation or credit refresh.
3. For selections longer than 24 words, the panel automatically requests a
   constrained TL;DR. Shorter selections skip generation and show an
   “Already concise” note.
4. Ask follow-up questions in the composer.
5. Click an attributed span in an answer to highlight and center the matching
   source text in the originating page frame.

## Components

- **`manifest.json`** injects `content.js` and `content.css` at
  `document_start` with `all_frames`, `match_about_blank`, and
  `match_origin_as_fallback` enabled.
- **`background.js`** owns the context menu, starts the side-panel open, captures
  from `info.frameId`, and stores and broadcasts a versioned selection seed.
- **`content.js`** snapshots selections, creates the canonical text-to-DOM map,
  resolves document offsets, repairs mappings after supported DOM rerenders,
  renders the source highlight, and scrolls nested panes.
- **`sidepanel/panel.js`** manages auth, chat history, summary policy, fixed
  attribution-span rendering, and frame-targeted highlight messages.
- **`sidepanel/panel-logic.js`** contains pure summary and Unicode-safe
  truncation helpers.
- **`sidepanel/tokenpath.js`** calls TokenPath directly with the API key in
  `chrome.storage.local` and adapts `/v1/answer` attribution spans for the panel.

## Selection capture and panel bootstrap

The context-menu callback supplies flattened `selectionText` but not DOM nodes.
Each frame therefore listens for selection changes, clones the current `Range`,
and eagerly extracts it during `contextmenu`.

`chrome.sidePanel.open()` must begin synchronously in the click gesture, but the
background worker does not await it. It first starts an idempotent script and CSS
injection into the originating `frameId`, covering tabs that predate an unpacked
extension reload, then immediately sends `capture-selection`. Missing receivers
and content-level capture failures are retried once after injection completes.
This ordering keeps the panel animation and credit lookup off the capture path.

An eagerly extracted DOM `Range` is authoritative. Chrome's flattened
`selectionText` is only a recovery hint when late injection missed the
`contextmenu` event. Hint recovery:

- removes invisible formatting characters and collapses Unicode whitespace;
- applies length-preserving ASCII case folding for CSS `text-transform`;
- omits text beneath `user-select:none` controls; and
- accepts only a unique occurrence.

These rules cover current Substack and X selection shapes without silently
choosing the wrong duplicate.

Every seed carries `captureId`, `capturedAt`, `tabId`, `windowId`, and `frameId`.
IDs are allocated before extraction, so click order—not async completion
order—defines freshness. The panel installs its live listener before active-tab
lookup, seed replay, or credit validation. Duplicate and stale seeds cannot
replace a newer selection or change its highlight route.

## Canonical extraction and node map

The content script walks visible text nodes intersecting the stored range. It
collapses whitespace per text node, inserts `\n` at block or `<br>` boundaries,
and records every emitted character's raw node offset:

```js
{ start, end, node, rawOffsets }
```

`start` and `end` index the canonical extraction string in JavaScript UTF-16
code units. The node map never crosses the extension-message boundary. The exact
canonical string is sent as TokenPath's `document` and is not normalized again,
so returned source bounds map back to the same characters.

## Summary and generation policy

For a source of `N` whitespace-delimited words:

- `N <= 24`: skip the automatic model call.
- Otherwise request at most `min(80, max(12, floor(0.3 * N)))` words.
- Set `max_output_tokens` to
  `min(128, max(16, ceil(maxWords * 1.6)))`.

The prompt asks only for the central point, with no title, label, preamble,
explanation, or closing comment. A long whitespace-free CJK selection uses a
proportional character budget instead. A deterministic display guard substitutes
a bounded extractive prefix if the model's result is not strictly shorter or
exceeds the requested budget. Document and conversation limits are counted by
Unicode code point so truncation does not split surrogate pairs.

## Generation and fixed-span attribution

Each generated turn uses one `POST /v1/answer` request containing the canonical
document, the latest question, bounded prior turns, and—only for automatic
summaries—`max_output_tokens`.

The response contains the answer plus server-selected spans:

```js
{
  answer: "...",
  attributions: [{
    answer: { start, end },
    source: { start, end, confidence }
  }]
}
```

The API client adapts each attributed source to
`{answerStart, answerEnd, sourceStart, sourceEnd, confidence}`. Entries with a
null source are not clickable. The panel renders nonoverlapping answer ranges as
`.attrib` spans; clicking one sends its source bounds to the frame from which
that answer's selection was captured.

Character bounds, rather than a text search, identify the intended occurrence
when a phrase such as `Fable 5` appears more than once in the captured document.

## Mutation and ambiguity policy

Before highlighting, the content script verifies that the route, stable source
scope, visibility, and mapped characters are still current. This catches both
detached subtrees and connected Text nodes whose data React changed in place.

If the DOM changed, it first restores the original range beneath a stable Gmail
message ID, public X tweet ID, logged-in X status permalink, X Article root, or
unique non-X element ID. If child paths moved, it rebases the **complete captured
selection** inside that same identified source and then reapplies the server's
relative source bounds. A stable source is never allowed to fall through to a
page-wide match, where the same words might belong to another message or post.

Identity-less captures may use a body-wide fallback only when the complete
captured text occurs exactly once. Missing or duplicate matches fail visibly;
the extension does not use `window.find` or select the first arbitrary copy.

## Message protocol

| From → To | Type | Important payload |
|---|---|---|
| background → content frame | `capture-selection` | `captureId`, `selectionText`, targeted `frameId` |
| background → panel | `selection-captured` | `captureId`, time, tab/window/frame IDs, `text` or `error` |
| panel → content frame | `highlight` | `captureId`, `start`, `end`, targeted `frameId` |
| panel → content frame | `clear-highlight` | `captureId`, targeted `frameId` |

## Lifecycle and non-goals

A URL change invalidates source mapping and requires a new capture. Capture IDs,
context versions, and highlight epochs prevent stale generation or click work
from overwriting or clearing a newer selection's highlight.

Out of scope for this version: whole-page or Readability extraction,
shadow-root traversal, streaming answers, persisted chats, OAuth, and restricted
Chrome pages. A selection belongs to one frame; cross-frame selections are
unsupported.
