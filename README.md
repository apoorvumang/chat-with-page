# chat-with-page

**TLDR** is a Chrome MV3 extension for chatting with text selected on a web
page. Select text, right-click **TLDR**, then use the side panel to summarize it
or ask follow-up questions. TokenPath returns attributed answer spans; clicking
one highlights and scrolls to its exact source text in the page.

## Load it unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `tldr-extension/`.
4. Select text on a normal web page, right-click, and choose **TLDR**.

On first use, paste a TokenPath API key from
[platform.tokenpath.ai](https://platform.tokenpath.ai). No separate LLM key is
needed.

Selections of 24 words or fewer are already concise, so the extension skips the
automatic model summary. Longer selections get an adaptive TL;DR prompt and
output-token ceiling that scale with the source while remaining shorter than it.
Long CJK text uses an equivalent character budget instead of being mistaken for
a one-word selection.

## How it works

1. Content scripts run from `document_start` in every frame. They snapshot the
   live selection and eagerly extract it on `contextmenu`, before a dynamic page
   such as Gmail or Substack can replace or normalize its DOM selection.
2. The background worker starts an idempotent injection into the exact source
   frame, covering tabs that were open before an extension reload. It opens the
   side panel without awaiting its animation and captures immediately. A missing
   listener or stale capture response is retried once after injection. Once the
   DOM map is safely captured, the native page selection is cleared.
3. One authenticated `POST /v1/answer` request generates the grounded answer and
   returns server-selected attribution spans. Each span contains character
   bounds in both the answer and the selected source document.
4. The panel renders those answer spans as clickable claims. Clicking one sends
   its exact `source.start` and `source.end` bounds to the originating tab and
   frame.
5. The content script maps those document offsets back to live DOM `Range`s,
   highlights the source with the CSS Custom Highlight API, and scrolls it into
   view, including through nested panes such as Gmail's message view.

Character bounds disambiguate repeated strings in the original extraction. If
Gmail or X later replaces the selected subtree, the extension restores the
selection beneath a stable message, post, status, or article identity and remaps
the complete captured text within that source. It rejects ambiguous body-wide
matches rather than jumping to the first copy.

Late-injection recovery also handles invisible formatting characters, Unicode
whitespace, CSS-uppercase text, and `user-select:none` controls found on pages
such as Substack and X.

Only the extracted selection, questions, and bounded conversation context are
sent to TokenPath. The DOM node map remains inside the source frame.

## API and local development

The side panel calls TokenPath directly using the key stored in
`chrome.storage.local`. To use staging or a local backend, run this in the panel
DevTools console:

```js
chrome.storage.local.set({ tokenpathBaseUrl: "http://localhost:8000" })
```

See [`tokenpath-integration.md`](./tokenpath-integration.md) for request shapes
and [`spec.md`](./spec.md) for the extension architecture.

## Layout

```text
tldr-extension/
├── manifest.json
├── background.js              # nonblocking, frame-aware capture
├── content.js                 # extraction, node map, remap, highlight
├── content.css                # source attribution highlight
└── sidepanel/
    ├── panel.html
    ├── panel.js               # chat and clickable attributed spans
    ├── panel-logic.js         # summary and Unicode-safe helpers
    └── tokenpath.js           # authenticated `/v1/answer` client
```

Test instructions and coverage are in
[`tldr-extension/test/README.md`](./tldr-extension/test/README.md).
