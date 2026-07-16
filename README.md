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

Working end-to-end **except** the LLM call, which is a stub. No API keys are
needed to build or test the extension.

## Wiring the real LLM + TokenPath

Everything routes through one function — `askLLM(context, messages)` at the
bottom of [`tldr-extension/sidepanel/panel.js`](./tldr-extension/sidepanel/panel.js).
Replace its body with your real call. Its contract:

```js
askLLM(context, messages) -> {
  answer: string,
  attributions: [{ answerStart, answerEnd, sourceStart, sourceEnd }]
}
```

- `context` is the exact extracted selection string.
- `answerStart` / `answerEnd` are char offsets into `answer`.
- `sourceStart` / `sourceEnd` are char offsets into `context`; the content
  script maps these to live DOM nodes for highlighting. **Do not re-normalize
  whitespace** on the answer side — offsets must refer to `context` verbatim.

Nothing else in the UI or content script needs to change.

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
