// TokenPath API client for the side panel (Phase 0: pasted API key).
//
// The panel page calls the TokenPath platform directly — with the
// host_permissions in manifest.json, MV3 extension-page fetches are not
// subject to CORS, so TokenPath *is* the backend. The key lives in
// chrome.storage.local. To point at staging or a local backend, set
// tokenpathBaseUrl in storage from the service worker / panel console:
//   chrome.storage.local.set({ tokenpathBaseUrl: "http://localhost:8000" })

const TOKENPATH_DEFAULT_BASE_URL = "https://api.tokenpath.ai";
const TOKENPATH_PLATFORM_URL = "https://platform.tokenpath.ai";
const TOKENPATH_MAX_DOCUMENT_CHARS = 400_000;

class TokenPathError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "TokenPathError";
    this.status = status;
    this.code = code;
  }
}

const TokenPath = {
  Error: TokenPathError,
  PLATFORM_URL: TOKENPATH_PLATFORM_URL,
  MAX_DOCUMENT_CHARS: TOKENPATH_MAX_DOCUMENT_CHARS,

  async getAuth() {
    const stored = await chrome.storage.local.get([
      "tokenpathKey",
      "tokenpathBaseUrl",
    ]);
    return {
      key: stored.tokenpathKey || null,
      baseUrl: stored.tokenpathBaseUrl || TOKENPATH_DEFAULT_BASE_URL,
    };
  },

  async setKey(key) {
    await chrome.storage.local.set({ tokenpathKey: key });
  },

  async clearKey() {
    await chrome.storage.local.remove("tokenpathKey");
  },

  // GET /v1/me/credits — also serves as key validation on connect.
  async fetchCredits() {
    const body = await this._request("GET", "/v1/me/credits");
    return body.available_tokens;
  },

  // POST /v1/answer — generate a grounded answer and attribute it.
  // Returns { answer, attributions, creditsRemaining } in the panel's shape.
  async answer({ document, question, messages, maxOutputTokens }) {
    const payload = {
      document,
      question,
      messages,
    };
    if (Number.isFinite(maxOutputTokens)) {
      payload.max_output_tokens = Math.trunc(maxOutputTokens);
    }
    const body = await this._request("POST", "/v1/answer", payload);
    const attributions = (body.attributions || [])
      .filter((span) => span.source)
      .map((span) => ({
        answerStart: span.answer.start,
        answerEnd: span.answer.end,
        sourceStart: span.source.start,
        sourceEnd: span.source.end,
        confidence: span.source.confidence,
      }));
    return {
      answer: body.answer,
      attributions,
      creditsRemaining:
        typeof body.credits_remaining === "number"
          ? body.credits_remaining
          : null,
    };
  },

  async _request(method, path, payload) {
    const { key, baseUrl } = await this.getAuth();
    if (!key) {
      throw new TokenPathError(401, "not_connected", "Not connected to TokenPath.");
    }

    // Generation + attribution on a big selection can take a while; fail
    // clearly rather than hanging forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    let res;
    try {
      res = await fetch(baseUrl.replace(/\/$/, "") + path, {
        method,
        headers: {
          Authorization: "Bearer " + key,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw new TokenPathError(
        0,
        e.name === "AbortError" ? "timeout" : "network_error",
        e.name === "AbortError"
          ? "TokenPath took too long to respond."
          : "Couldn't reach TokenPath — check your connection."
      );
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      // fall through with body = null
    }
    if (!res.ok) {
      const err = (body && body.error) || {};
      throw new TokenPathError(
        res.status,
        err.code || "http_" + res.status,
        err.message || "TokenPath request failed (" + res.status + ")."
      );
    }
    return body || {};
  },
};

function formatTokens(n) {
  if (n == null) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
