# Spec: TokenPath Integration for the TLDR Extension

> **Status (2026-07): Phase 0 implemented.** The TokenPath backend gained
> `POST /v1/answer` (combined generate + attribute, decision D1a) and this
> extension is wired to it with pasted-key auth (D5). Generation runs on
> `google/gemini-3.1-flash-lite` via OpenRouter (D3); span selection is
> server-side via `[[citation marks]]` the model emits, with sentence-level
> fallback (D4). Sign-in is required before the first query (D2). Phase 1
> (OAuth PKCE) and D6/D7 remain open.

## Purpose

Wire the TLDR Chrome extension (see [`spec.md`](./spec.md)) to the real TokenPath
platform so it becomes a **live demo / top-of-funnel asset** for the TokenPath
API. The extension is not a standalone product; its job is to show off
token-level attribution ("click a claim → highlight the exact source span on the
live page") to the developers and teams who buy the API.

Two sides need to move:

- **Extension side** — replace the stubbed `askLLM()` with authenticated calls
  to TokenPath, add a "Sign in with TokenPath" flow, render confidence.
- **TokenPath side (this is the ask for the TokenPath agent)** — add a
  **generation** capability metered on the same credits, and an **extension
  auth flow**. The attribution API already exists and fits as-is.

The product decision driving this: **if the user is signed in to TokenPath,
generation is free to them and billed against their TokenPath credits until they
run out.** No separate billing, no BYO-OpenAI-key.

---

## Current state (verified against docs.tokenpath.ai, 2026-07)

### What exists and works today

**Auth** — Bearer API keys in `Authorization: Bearer <key>`. Keys look like
`tpk_live_<project>_<secret>`. Scopes: `attributions:write` (POST
`/v1/attributions`, `/v1/attributions/heatmap`) and `usage:read` (GET `/v1/me`,
`/v1/me/credits`, `/v1/me/usage`). Missing scope → `403 missing_scope`.

**`POST /v1/attributions`** — the core capability. Request:

```json
{
  "document": "string",
  "question": "string",
  "answer": "string",
  "spans": [[13, 26], [42, 45]],
  "threshold": 0.001
}
```

- `spans` are `[start, end]` **character offsets into `answer`** (half-open).

Response:

```json
{
  "spans": [
    {
      "answer": { "start": 13, "end": 26, "text": "$5.87 billion" },
      "source": { "start": 26, "end": 39, "text": "$5.87 billion", "confidence": 0.78 }
    }
  ]
}
```

- `source.start`/`source.end` are **character offsets into `document`**.
  `source` is `null` when nothing attributes above `threshold`.

**Why this is great news for us:** the extension already speaks in character
offsets into the extracted page text. `document` == our extraction string,
`source.{start,end}` feed straight into the content-script node map, and
`answer.{start,end}` feed straight into the panel's clickable-span renderer. The
offset contract lines up with **zero re-normalization** — exactly what
[`spec.md`](./spec.md) demanded.

### What is stubbed in the extension

`askLLM(context, messages)` in `tldr-extension/sidepanel/panel.js` returns fake
`{ answer, attributions }`. Everything downstream of it (extraction, node map,
sentence-snap, CSS Custom Highlight round-trip) is real and tested
(`tldr-extension/test/`).

### What does NOT exist yet on TokenPath (the backend work)

1. **A generation endpoint.** TokenPath is attribution-only today. The extension
   needs an answer to attribute.
2. **An extension-friendly auth flow.** Today auth = a raw API key from the
   dashboard. A consumer-facing "Sign in with TokenPath" button needs an OAuth
   (or equivalent token-issuance) flow that returns a scoped token to a Chrome
   extension.
3. **Credits gating semantics** for generation + a clean "out of credits" error.

---

## Target architecture

```
┌─────────────────┐   1. sign in (OAuth PKCE)     ┌──────────────────────┐
│  TLDR extension │ ───────────────────────────►  │  TokenPath platform  │
│  (side panel)   │ ◄───────────── scoped token   │                      │
│                 │                                │  NEW  /v1/answer     │  generate + attribute,
│  askLLM()  ─────┼── 2. POST /v1/answer  ───────► │       (or /v1/chat)  │  bill credits
│                 │      {document, question}      │  EXISTS /v1/attribut.│
│                 │ ◄──── {answer, attributions,   │       /v1/me/credits │
│                 │        credits_remaining}      │                      │
└─────────────────┘                                └──────────────────────┘
        │
        │ 3. render answer; on span click send {start,end} to content script
        ▼
   content.js highlights the exact source span on the live page
```

The extension calls TokenPath **directly from the side panel** (an extension
page). With `host_permissions` for the TokenPath host, MV3 extension-page fetches
are not blocked by CORS, so **no separate proxy backend is required** — TokenPath
*is* the backend. (A content script could not do this; the panel can.)

---

## Backend changes required on TokenPath

> This section is the handoff to the TokenPath agent. Field names are proposals —
> adjust to match platform conventions, but keep the offset semantics.

### B1. Generation endpoint (metered on credits)

Two viable shapes; **we recommend the combined endpoint (B1a)** because it makes
the extension a single authenticated round-trip and is the cleanest demo.

#### B1a. Combined: `POST /v1/answer` (recommended)

Generate an answer grounded in `document`, then attribute it, in one call.

Request:

```json
{
  "document": "string",          // the extracted page selection (verbatim)
  "question": "string",          // latest user turn
  "messages": [                  // optional prior turns for follow-ups
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "model": "string (optional)",  // server picks a sensible default
  "threshold": 0.001,            // passthrough to attribution
  "max_output_tokens": 512
}
```

Response:

```json
{
  "answer": "string",
  "attributions": [
    {
      "answer": { "start": 0, "end": 27, "text": "..." },
      "source": { "start": 140, "end": 172, "text": "...", "confidence": 0.82 }
    }
  ],
  "usage": { "input_tokens": 0, "output_tokens": 0, "attributed_tokens": 0 },
  "credits_remaining": 9873321
}
```

- `answer.{start,end}` are char offsets into `answer`; `source.{start,end}` are
  char offsets into `document`. **Same semantics as `/v1/attributions`.**
- **Span selection is server-side here.** The endpoint must segment `answer`
  into claim spans before attributing. Start with **sentence-level** segmentation
  (good enough for the demo); the docs' own guidance ("send short answer spans:
  numbers, names, dates, entities") can refine this later. See Decision D4.
- Billing: charge generation + attribution against the caller's credits; return
  the updated `credits_remaining` so the extension can surface it.

#### B1b. Composable alternative: `POST /v1/chat` + existing `/v1/attributions`

If a combined endpoint is undesirable, expose generation alone:

```
POST /v1/chat  →  { "answer": "string", "usage": {...}, "credits_remaining": N }
```

The extension then segments the answer itself and calls the existing
`/v1/attributions`. Downside: two authenticated round-trips and client-side span
selection. Acceptable, but B1a is preferred for the demo.

**New scope:** generation needs its own scope, e.g. `generate:write` (or fold
into an existing one). The extension's token must carry generation +
`attributions:write` + `usage:read`.

### B2. Extension auth flow ("Sign in with TokenPath")

Target UX: user clicks **Sign in with TokenPath** in the panel, a TokenPath
login page opens, they approve, the extension receives a scoped token. Standard
approach for MV3 is **OAuth 2.0 Authorization Code + PKCE** via
`chrome.identity.launchWebAuthFlow`.

What TokenPath needs to provide:

- **`GET /oauth/authorize`** — accepts `client_id`, `redirect_uri`,
  `code_challenge` (S256), `scope`, `state`; renders login/consent; redirects to
  `redirect_uri` with `?code=...&state=...`.
- **`POST /oauth/token`** — exchanges `code` + `code_verifier` for
  `{ access_token, refresh_token?, expires_in, scope }`. **Public client, no
  client secret** (a secret can't be kept in an extension).
- **Registered redirect URI:** `https://<EXTENSION_ID>.chromiumapp.org/`
  (`chrome.identity.getRedirectURL()` produces this). The extension ID is stable
  once published; for dev it's derived from a `key` in the manifest — TokenPath
  should allow registering both the dev and prod IDs.
- Issued tokens should be **scoped narrowly** (generation + attribution + usage
  read) and ideally short-lived with refresh.

**Interim fallback (Phase 0, zero OAuth work):** an options page where the user
pastes a `tpk_live_...` key from `platform.tokenpath.ai`. Lets us ship the demo
before OAuth lands. The key lives in `chrome.storage.local` (the user's own key,
their own machine — acceptable). Ship Phase 0, upgrade to OAuth in Phase 1.

### B3. Credits gating + errors

- If the caller is out of credits, generation/answer endpoints return a distinct,
  documented error the extension can catch — e.g. **`402 insufficient_credits`**
  with `{ "error": "insufficient_credits", "credits_remaining": 0 }`.
- `GET /v1/me/credits` is used by the extension to show a balance and to prompt a
  top-up (a conversion moment). Confirm its response shape (e.g.
  `{ "credits_remaining": N, "granted": N, "used": N }`).

### B4. Operational

- **CORS:** direct calls come from the extension page (origin
  `chrome-extension://<id>`), which MV3 exempts from CORS given `host_permissions`
  — so server CORS is not strictly required for the API calls. **But** the OAuth
  `authorize` page runs in a normal browser tab and the `token` exchange is a
  `fetch` from the extension; confirm the token endpoint accepts the
  extension origin. Document any required `Access-Control-Allow-Origin`.
- **Rate limiting:** a public demo needs abuse protection. Per-token and
  per-IP limits on `/v1/answer`. Consider a small anonymous/free tier (see D2).
- **Model choice / cost:** which model backs generation is a TokenPath decision
  (D3). A cheap, fast model is fine for a summarization demo.

---

## Extension changes required

The heavy lifting (extraction, node map, highlight) is done and tested. Changes:

1. **`manifest.json`**
   - `host_permissions`: `["https://api.tokenpath.ai/*"]` (confirm host).
   - `permissions`: add `"identity"` for `launchWebAuthFlow`.

2. **Auth module** (`sidepanel/auth.js` or in `panel.js`)
   - Phase 0: read a pasted key from `chrome.storage.local`.
   - Phase 1: `chrome.identity.launchWebAuthFlow` PKCE flow → store
     `access_token` (+ refresh) in `chrome.storage.local`; refresh on 401.
   - "Sign in with TokenPath" button + signed-in state + credit balance in the
     panel header.

3. **Replace `askLLM(context, messages)`** — one `fetch` to `POST /v1/answer`:

   ```js
   async function askLLM(context, messages) {
     const { access_token } = await chrome.storage.local.get("access_token");
     const question = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
     const res = await fetch("https://api.tokenpath.ai/v1/answer", {
       method: "POST",
       headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
       body: JSON.stringify({ document: context, question, messages }),
     });
     if (res.status === 401) { /* refresh or re-auth */ }
     if (res.status === 402) { /* show "out of credits" + top-up CTA */ }
     const data = await res.json();
     // adapt TokenPath shape -> the extension's existing attribution shape
     const attributions = data.attributions
       .filter(s => s.source)                       // drop unattributed claims
       .map(s => ({
         answerStart: s.answer.start, answerEnd: s.answer.end,
         sourceStart: s.source.start, sourceEnd: s.source.end,
         confidence: s.source.confidence,
       }));
     return { answer: data.answer, attributions, creditsRemaining: data.credits_remaining };
   }
   ```

   > `document: context` is sent **verbatim** — the whitespace-normalized
   > extraction string. Do not trim/re-normalize; `source` offsets index into it.

4. **Render confidence** — the panel already renders clickable spans; add a
   confidence affordance (opacity/tooltip like "94% match"). Optionally hide
   spans below a UI threshold.

5. **Branding / CTA** — "Powered by TokenPath — get the API" link to
   `platform.tokenpath.ai`; on `402`, a top-up prompt.

6. **Privacy notice** — the selected page text is sent to TokenPath. State this
   at sign-in (see Privacy below). No change to the "node map never leaves the
   content script" guarantee — only the extracted text string is sent.

Nothing in `content.js` changes: it already resolves `{start,end}` source
offsets against the live DOM.

---

## Auth sequence (Phase 1, OAuth PKCE)

```
extension                         chrome.identity                 TokenPath
   │  build authorize URL             │                              │
   │  (client_id, redirect_uri,       │                              │
   │   scope, state, code_challenge)  │                              │
   │ ───────────────────────────────►│ opens tab to /oauth/authorize│
   │                                  │ ────────────────────────────►│ user logs in / consents
   │                                  │ ◄──── 302 redirect_uri?code= │
   │ ◄──── redirect w/ code ──────────│                              │
   │  POST /oauth/token (code + verifier) ───────────────────────────►│ validate PKCE
   │ ◄──── { access_token, refresh_token, expires_in, scope } ────────│
   │  store token in chrome.storage.local                             │
```

`redirect_uri = chrome.identity.getRedirectURL()` =
`https://<extension-id>.chromiumapp.org/`. Register dev + prod extension IDs with
TokenPath.

---

## Data & privacy

- Only the **extracted selection text** and the user's questions are sent to
  TokenPath (as `document` / `question`). The DOM node map stays in the content
  script.
- Surface a plain-language notice at sign-in: "Text you select and your questions
  are sent to TokenPath to generate and attribute answers."
- For a consumer-facing listing, the Chrome Web Store requires a privacy policy;
  TokenPath's existing policy likely covers API data handling — confirm it
  extends to this use.

---

## Open decisions (for the TokenPath team)

- **D1 — Combined vs. composable:** ship `POST /v1/answer` (generate+attribute,
  recommended) or `POST /v1/chat` + client-side `/v1/attributions`?
- **D2 — Anonymous tier:** does the demo allow any use before sign-in (e.g. an
  IP-limited free trial to reduce first-use friction), or is sign-in required
  from the first query? Sign-in-first is simplest and best for lead capture.
- **D3 — Generation model & cost:** which model backs generation; expected
  credit cost per summary; default `max_output_tokens`.
- **D4 — Server-side span selection:** sentence-level to start? What granularity
  gives the best-looking highlights for the demo?
- **D5 — Auth timeline:** Phase 0 key-paste to ship immediately, then OAuth? Or
  block on OAuth?
- **D6 — Token lifetime / refresh:** access-token TTL, refresh-token support,
  and revocation.
- **D7 — Extension ID registration:** who registers the dev/prod
  `chromiumapp.org` redirect URIs.

---

## Phasing

- **Phase 0 — Working demo, minimal backend.** Add generation (`/v1/answer` or
  `/v1/chat`). Extension uses pasted API key. Full round-trip live. *(Unblocks a
  usable internal demo the fastest.)*
- **Phase 1 — Sign in with TokenPath.** OAuth PKCE + credits gating + top-up CTA.
  This is the shippable public demo.
- **Phase 2 — Polish.** Streaming answers, chat persistence, confidence UI,
  showcase documents (a filing / a paper) on the landing page where token-level
  attribution visibly beats chunk-citation.

---

## Appendix: shape mapping (TokenPath → extension)

| Extension field (existing) | TokenPath source                    |
|----------------------------|-------------------------------------|
| `answer` (string)          | `answer`                            |
| `attributions[].answerStart` | `attributions[].answer.start`     |
| `attributions[].answerEnd`   | `attributions[].answer.end`       |
| `attributions[].sourceStart` | `attributions[].source.start`     |
| `attributions[].sourceEnd`   | `attributions[].source.end`       |
| `attributions[].confidence` (new) | `attributions[].source.confidence` |
| `document` sent to API     | the content script's extraction string (verbatim) |

`source == null` claims are dropped client-side (unattributed → not clickable).
