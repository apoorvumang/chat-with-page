# TokenPath Integration for TLDR

> **Status (2026-07): live Phase 0.** The extension calls TokenPath directly
> with a pasted API key. One `/v1/answer` request generates each answer and
> returns its fixed attribution spans. OAuth PKCE remains future work.

## Current request flow

The side panel is an extension page, so its declared host permissions allow it
to call TokenPath without a proxy backend. The API key is stored in
`chrome.storage.local`.

The extension uses two endpoints:

1. `GET /v1/me/credits` validates the key and updates the displayed balance.
   This request does not block selection display or panel bootstrap.
2. `POST /v1/answer` generates a grounded answer and returns the server-selected
   answer-to-source spans in the same response.

There is no client-side attribution pass. The panel renders the returned answer
ranges as clickable spans and sends their returned source character bounds to
the originating page frame.

## Authentication and errors

Requests use:

```http
Authorization: Bearer tpk_live_...
Content-Type: application/json
```

The extension handles invalid or inactive keys (`401`/`403`), insufficient
credits (`402`), rate limiting (`429`), network failures, and a 90-second
timeout. Balance display requires the API key's usage-read permission; answer
generation and attribution require the permissions enforced by `/v1/answer`.

The default base URL is `https://api.tokenpath.ai`. For staging or local
development, set `tokenpathBaseUrl` in extension storage.

## `POST /v1/answer`

The client sends:

```json
{
  "document": "the canonical extracted selection",
  "question": "the latest user turn",
  "messages": [
    { "role": "user", "content": "bounded prior turn" },
    { "role": "assistant", "content": "bounded prior answer" }
  ],
  "max_output_tokens": 64
}
```

`max_output_tokens` is included for automatic summaries and omitted for normal
follow-ups. The server response is expected to contain:

```json
{
  "answer": "Fable 5 shipped worldwide.",
  "attributions": [
    {
      "answer": { "start": 0, "end": 7, "text": "Fable 5" },
      "source": {
        "start": 106,
        "end": 113,
        "text": "Fable 5",
        "confidence": 0.94
      }
    }
  ],
  "credits_remaining": 999
}
```

The offset contract is half-open Unicode code-point bounds (Python string
indices), not JavaScript UTF-16 code units:

- `answer.start` and `answer.end` index the exact returned `answer` string.
- `source.start` and `source.end` index the exact submitted `document` string.
- `source` may be null when the server cannot attribute a claim; the client
  leaves that answer text unclickable.

Immediately after receiving the response, the API adapter converts the answer
bounds against the returned `answer` and the source bounds against the exact
submitted `document`. All downstream panel slicing, extraction-map indexing,
and DOM `Range` boundaries therefore remain JavaScript-native UTF-16 offsets.
Searching by `source.text` is deliberately avoided because repeated text would
discard the server's occurrence-level disambiguation.

The client adapts valid spans to:

```js
{
  answerStart,
  answerEnd,
  sourceStart,
  sourceEnd,
  confidence
}
```

The panel does not create spans, parse citation-marker syntax, or add `[[...]]`
around answer text. If the backend uses markers while generating or selecting
claims, the returned `answer` must already be the intended display text and the
returned answer offsets must index that exact string.

## Summary policy

Automatic summarization is intentionally bounded:

- selections of 24 words or fewer skip automatic generation;
- longer selections target 30% of the source, clamped to 12–80 words;
- the output-token ceiling is roughly 1.6 times the word budget, clamped to
  16–128 tokens;
- the prompt requests only a shorter central-point TL;DR, with no title, label,
  preamble, explanation, or closing comment;
- long whitespace-free CJK selections use an equivalent character budget; and
- a deterministic display guard substitutes a bounded extractive prefix if the
  model violates the requested limit.

Document and conversation limits are counted in Unicode code points so the
client never truncates inside an emoji surrogate pair. The canonical document
is otherwise sent without another normalization pass, preserving source-offset
round trips.

If the deterministic summary guard replaces the server's answer, its spans are
not reused because they index a different string.

## Capture and source navigation contract

Content scripts run at `document_start` in all frames. The originating
`frameId` is preserved from the context-menu event through capture, seed
storage, answer rendering, highlighting, and clearing.

Capture is intentionally nonblocking: the background worker begins
`chrome.sidePanel.open()` but does not await it before requesting the selection.
The content script has already cloned and eagerly extracted the range at
`contextmenu`, avoiding the former multi-second delay and protecting against
immediate DOM replacement. The panel installs its live seed listener before
storage, active-tab, and credit awaits. Click-ordered capture IDs prevent a slow
older extraction from replacing a newer selection.

Each context-menu click also starts idempotent injection into the exact frame.
This covers pages that were already open when an unpacked extension was
reloaded. A missing receiver or stale content-level capture error is retried
once after injection.

For late-injection fallback, Chrome's flattened selection text is uniquely
remapped while tolerating invisible formatting characters, Unicode whitespace,
ASCII case differences caused by `text-transform`, and unselectable controls
used by Substack and X.

The server's source bounds identify the intended occurrence in the original
canonical document. If Gmail or X later replaces the selected DOM subtree, the
content script reconstructs the complete selection beneath its stable message,
post, status, or article identity before applying those bounds. Ambiguous
fallback matches fail instead of highlighting an arbitrary duplicate.

## Data and privacy

TokenPath receives the extracted selection, the user's questions, and bounded
prior text turns. It does not receive DOM nodes, page structure, unrelated page
text, or the extraction-to-node map.

## Future authentication

Phase 0 uses a raw pasted key. A public release should replace this with OAuth
2.0 Authorization Code + PKCE through `chrome.identity.launchWebAuthFlow`, using
a narrowly scoped, refreshable token and registered development and production
`chromiumapp.org` redirect URIs.
