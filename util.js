/**
 * Deterministic, non-cryptographic string hash (cyrb53-derived), used to tell whether a cached
 * value is stale relative to its source (world book sources, message cache keys).
 * @param {string} input
 * @returns {string}
 */
export function hashString(input) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

let nameCounter = 0;

/**
 * A file stem that is unique even for two pictures saved in the same millisecond (the pictures are drawn
 * two at a time, and `Date.now()` alone gave both the same name: the second upload replaced the first and two
 * frames showed the same picture).
 */
export function uniqueStamp() {
    nameCounter = (nameCounter + 1) % 1e6;
    const random = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
    return `${Date.now()}_${nameCounter}_${random}`;
}

/**
 * The words that identify a place or an object in a name, in any script: letters of any alphabet, accents
 * ignored ("Café" = "cafe"), at least 3 letters for the Latin alphabet and 2 for the others (one Arabic or Chinese
 * word is often two letters). Reading only a-z made every Arabic, Japanese or Cyrillic name empty.
 * @param {string} text
 * @param {Set<string>} [stop]
 * @returns {string[]}
 */
export function placeWords(text, stop = new Set()) {
    const plain = String(text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/['\u2019]s\b/g, '');
    return (plain.match(/[\p{L}\p{N}]+/gu) || []).filter((w) => {
        if (stop.has(w)) return false;
        const latin = /^[a-z0-9]+$/.test(w);
        return latin ? w.length >= 3 : w.length >= 2;
    });
}

/**
 * What an error REALLY says. SillyTavern's Connection Manager wraps every failure of a model call
 * (a 402 out of credit, a 401 bad key, a 429 rate limit, a 503 overload, a timeout, a 400 for a
 * parameter the model does not take) in `new Error('API request failed', { cause })`, so the screen said
 * "API request failed" and nothing else. This reads the chain of causes and returns the first
 * message that is not that generic wrapper, with a short hint for the common HTTP statuses. Pure.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
    const parts = [];
    for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
        const m = String(e?.message ?? e).trim();
        if (m && !parts.includes(m)) parts.push(m);
    }
    const generic = /^(API request failed|Response not OK|Failed to fetch)$/i;
    const specific = parts.filter((m) => !generic.test(m));
    // Only generic messages in the chain (e.g. 'API request failed' <- 'Response not OK'): show them all,
    // so the screen at least says the provider answered with an error and not that the call never left.
    const text = specific.length ? specific.join(' - ') : (parts.join(' - ') || 'unknown error');
    const hint = errorHint(text);
    return hint ? `${text} (${hint})` : text;
}

/** A plain-words reason for the usual provider failures, or ''. Pure. */
export function errorHint(text) {
    const t = String(text || '');
    if (/\b402\b|insufficient (credit|funds)|payment required|out of credit/i.test(t)) return 'OpenRouter credit is used up or the key limit was reached';
    if (/\b401\b|\b403\b|invalid api key|unauthori[sz]ed|forbidden|no auth|key.*(expired|disabled)/i.test(t)) return 'the API key is wrong, expired or disabled';
    if (/\b429\b|rate.?limit|too many requests/i.test(t)) return 'rate limit - wait a little';
    if (/\b50[0234]\b|overloaded|high demand|temporarily unavailable|bad gateway/i.test(t)) return 'the provider is busy - usually passes by itself';
    if (/\b404\b|no endpoints found|model.*not found/i.test(t)) return 'the model id does not exist or no provider serves it with these options';
    if (/\b400\b|bad request|unsupported|invalid.*(param|schema)/i.test(t)) return 'the model rejected a setting in the request (check model id, reasoning effort, structured output)';
    if (/abort|timed? ?out|took longer/i.test(t)) return 'no answer in time';
    return '';
}

/** Whether trying the same call again can help: busy / rate-limited / network, never a wrong key, no credit or a bad request. Pure. */
export function isTransientError(error) {
    const t = describeError(error);
    if (/\b(400|401|402|403|404)\b|invalid api key|insufficient|unauthori[sz]ed|no endpoints|bad request|No Connection Profile/i.test(t)) return false;
    return true;
}
