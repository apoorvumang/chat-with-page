// Pure helpers shared by the side-panel UI and its unit tests.

const TldrPanelLogic = (() => {
  const SHORT_SELECTION_WORDS = 24;

  function words(text) {
    return String(text || "").trim().match(/\S+/g) || [];
  }

  const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

  function measure(text) {
    const clean = String(text || "").trim();
    const wordList = words(clean);
    const codePoints = Array.from(clean);
    const characterMode = wordList.length <= 1 && CJK_RE.test(clean);
    return {
      clean,
      wordList,
      codePoints,
      characterMode,
      units: characterMode ? codePoints.length : wordList.length,
    };
  }

  function buildSummaryRequest(text) {
    const source = measure(text);
    const shortLimit = source.characterMode ? 48 : SHORT_SELECTION_WORDS;
    if (source.units <= shortLimit) {
      return {
        skip: true,
        sourceWords: source.wordList.length,
        sourceUnits: source.units,
      };
    }

    const maxUnits = source.characterMode
      ? Math.min(160, Math.max(24, Math.floor(source.units * 0.3)))
      : Math.min(80, Math.max(12, Math.floor(source.units * 0.3)));
    const maxOutputTokens = Math.min(
      128,
      Math.max(16, Math.ceil(maxUnits * (source.characterMode ? 2 : 1.6)))
    );
    const unitLabel = source.characterMode ? "characters" : "words";
    return {
      skip: false,
      sourceWords: source.wordList.length,
      sourceUnits: source.units,
      maxWords: source.characterMode ? null : maxUnits,
      maxUnits,
      maxOutputTokens,
      prompt:
        "Write only a TL;DR of the selected text in at most " +
        maxUnits +
        " " +
        unitLabel +
        ". It must be shorter than the selection. Preserve only the " +
        "central point. Do not add a title, a 'TL;DR:' label, a preamble, " +
        "an explanation, or a closing comment.",
    };
  }

  // The prompt and token ceiling should normally enforce this. This final
  // guard makes the user-facing contract deterministic if a model ignores
  // them: a TL;DR is always bounded and visibly shorter than its source.
  function enforceShorterSummary(answer, source, requestedMaxUnits = null) {
    const cleanAnswer = String(answer || "").trim();
    const sourceMeasure = measure(source);
    const answerMeasure = measure(cleanAnswer);
    const answerUnits = sourceMeasure.characterMode
      ? answerMeasure.codePoints.length
      : answerMeasure.wordList.length;
    const budget = Math.max(
      1,
      Math.min(
        Number.isFinite(requestedMaxUnits)
          ? Math.trunc(requestedMaxUnits)
          : Math.max(1, sourceMeasure.units - 1),
        Math.max(1, sourceMeasure.units - 1)
      )
    );
    if (
      cleanAnswer &&
      answerUnits < sourceMeasure.units &&
      answerUnits <= budget &&
      answerMeasure.codePoints.length < sourceMeasure.codePoints.length
    ) {
      return cleanAnswer;
    }

    // Deterministic extractive fallback: even if the model ignores both the
    // prompt and token ceiling, never render the whole source as its own TL;DR.
    return sourceMeasure.characterMode
      ? sourceMeasure.codePoints.slice(0, budget).join("") + "…"
      : sourceMeasure.wordList.slice(0, budget).join(" ") + "…";
  }

  // TokenPath's limits use Unicode code points; String#slice uses UTF-16 code
  // units. Avoid splitting a surrogate pair at the document limit.
  function truncateCodePoints(text, maxCodePoints) {
    const value = String(text || "");
    if (!Number.isFinite(maxCodePoints) || maxCodePoints < 0) return value;
    let codePoints = 0;
    let codeUnits = 0;
    while (codeUnits < value.length && codePoints < maxCodePoints) {
      const point = value.codePointAt(codeUnits);
      codeUnits += point > 0xffff ? 2 : 1;
      codePoints++;
    }
    return value.slice(0, codeUnits);
  }

  // TokenPath returns Python-style Unicode code-point offsets, but browser
  // strings and DOM Range boundaries use UTF-16 code units. Build this once
  // per API string so every attribution bound can be translated without
  // searching for its text (which would be ambiguous when a phrase repeats).
  function codePointToUtf16Map(text) {
    const map = [0];
    let utf16Offset = 0;
    for (const character of String(text || "")) {
      utf16Offset += character.length;
      map.push(utf16Offset);
    }
    return map;
  }

  function codePointOffsetToUtf16(map, offset) {
    if (!Number.isInteger(offset)) return NaN;
    const index = offset;
    if (index < 0 || index >= map.length) return NaN;
    return map[index];
  }

  return {
    SHORT_SELECTION_WORDS,
    buildSummaryRequest,
    enforceShorterSummary,
    truncateCodePoints,
    codePointToUtf16Map,
    codePointOffsetToUtf16,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TldrPanelLogic;
}
