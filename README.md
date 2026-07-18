# chat-with-page

**TLDR** — a Chrome MV3 extension. Select text on any page → right-click **TLDR** →
a side panel opens with a chat scoped to the selection. Answers are attributed
back to the source; clicking an attributed span highlights and scrolls to the
exact text in the live page (via the CSS Custom Highlight API).

See [`spec.md`](./spec.md) for the full design.

## Load it (unpacked)

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select the `tldr-extension/` folder.
4. Select text on any normal web page, right-click → **TLDR**.

The side panel opens seeded with your selection and auto-generates a summary.
Click any highlighted (dashed-underline) span in an answer to jump to and
highlight that text in the page. Type follow-up questions in the box.

## Status

Wired end-to-end to the live TokenPath platform (see
[`tokenpath-integration.md`](./tokenpath-integration.md), Phase 0). On first
use the panel asks you to connect a TokenPath API key — get one (with 10M free
tokens) at [platform.tokenpath.ai](https://platform.tokenpath.ai). Answers are
generated **and** attributed by one authenticated call to
`POST https://api.tokenpath.ai/v1/answer`; there is no separate LLM key.

To point the extension at staging or a local backend, set an override in the
panel's DevTools console:

```js
chrome.storage.local.set({ tokenpathBaseUrl: "http://localhost:8000" })
```

## How the wiring works

Everything routes through one function — `askLLM(context, messages)` at the
bottom of [`tldr-extension/sidepanel/panel.js`](./tldr-extension/sidepanel/panel.js),
backed by the API client in
[`tldr-extension/sidepanel/tokenpath.js`](./tldr-extension/sidepanel/tokenpath.js).
Its contract:

```js
askLLM(context, messages) -> {
  answer: string,
  attributions: [{ answerStart, answerEnd, sourceStart, sourceEnd, confidence }],
  creditsRemaining: number | null
}
```

- `context` is the exact extracted selection string, sent verbatim as the
  `document` — never trimmed or re-normalized, so response offsets index
  straight into it.
- `answerStart` / `answerEnd` are char offsets into `answer`.
- `sourceStart` / `sourceEnd` are char offsets into `context`; the content
  script maps these to live DOM nodes for highlighting.
- Only the extracted selection and your questions are sent to TokenPath; the
  DOM node map never leaves the content script.

## Layout

```
tldr-extension/
├── manifest.json
├── background.js          # context menu + side panel open + selection relay
├── content.js             # selection snapshot, extraction + node map, highlight
├── content.css            # ::highlight(tldr-attrib) style
└── sidepanel/
    ├── panel.html
    ├── panel.js           # chat UI + askLLM() stub
    └── panel.css
```
