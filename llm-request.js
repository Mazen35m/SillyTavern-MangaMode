// Structured (JSON-schema) LLM calls through a SillyTavern Connection Profile, shared by the scene
// parser and the appearance extractor.
//
// Two things the plain `sendRequest(...)` path could not give us:
// - the provider's own usage report (tokens, thinking tokens, cost) - shown in the debug panel so
//   the price of a reply is a measured number, not a guess;
// - an honest failure when the model's answer was cut off. SillyTavern turns unparseable JSON into
//   `{}` silently; that empty object passed validation and drew a random girl with a heart
//   (Vanessa chat, 2026-09-25). Here a truncated or empty answer is an error, so the caller's
//   retry takes over.
//
// It also turns the model's hidden "thinking" down (reasoning_effort): thinking tokens are billed
// as output, and on a thinking model they are most of a parse's cost - and when they ate the whole
// output budget the JSON came back truncated (GLM 5.3, 2026-09-25).

/** Reasoning-effort choices offered in settings. 'default' sends nothing (the model's own default). */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'default'];

/**
 * @param {object} raw Provider response (OpenAI-shaped from SillyTavern's backend).
 * @returns {{promptTokens: number|null, completionTokens: number|null, reasoningTokens: number|null, cost: number|null} | null}
 */
export function readUsage(raw) {
    const u = raw?.usage;
    if (u && typeof u === 'object') {
        return {
            promptTokens: numberOrNull(u.prompt_tokens),
            completionTokens: numberOrNull(u.completion_tokens),
            reasoningTokens: numberOrNull(u.completion_tokens_details?.reasoning_tokens),
            // Prompt tokens served from the provider's cache (billed at a fraction of the input price).
            cachedTokens: numberOrNull(u.prompt_tokens_details?.cached_tokens),
            cost: numberOrNull(u.cost),
        };
    }
    const g = raw?.usageMetadata;
    if (g && typeof g === 'object') {
        return {
            promptTokens: numberOrNull(g.promptTokenCount),
            completionTokens: numberOrNull((g.candidatesTokenCount ?? 0) + (g.thoughtsTokenCount ?? 0)),
            reasoningTokens: numberOrNull(g.thoughtsTokenCount),
            cost: null,
        };
    }
    return null;
}

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Text of the first choice, whatever shape the backend returned. */
export function messageText(raw) {
    const choice = raw?.choices?.[0];
    const content = choice?.message?.content ?? choice?.text ?? raw?.content ?? '';
    if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
    return String(content ?? '');
}

/** Parses a JSON answer, tolerating a ```json fence or text around the object. Null if impossible. */
export function parseJsonAnswer(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    const attempt = (value) => {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    };
    const direct = attempt(trimmed);
    if (direct) return direct;
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        const inner = attempt(fenced[1].trim());
        if (inner) return inner;
    }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return attempt(trimmed.slice(first, last + 1));
    return null;
}

/**
 * Sends a structured request and returns the parsed object plus usage. Throws when the answer is
 * empty, truncated or not JSON - never returns a silent `{}`.
 * @param {object} context SillyTavern.getContext()
 * @param {string} profileId Connection Profile id
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} maxTokens
 * @param {{name: string, description?: string, value: object, strict?: boolean}} jsonSchema
 * @param {{signal?: AbortSignal, reasoningEffort?: string, label?: string}} [options]
 * @returns {Promise<{content: object, usage: object|null, finishReason: string|null}>}
 */
export async function requestJson(context, profileId, messages, maxTokens, jsonSchema, { signal, reasoningEffort = 'minimal', label = 'LLM', cacheSystem = false, override: extra = {} } = {}) {
    // `extra` can pick another model on the same route (the quality check runs on a cheaper one).
    const override = { ...extra, json_schema: jsonSchema };
    if (cacheSystem && cacheableProfile(context, profileId)) messages = withCachedSystem(messages);
    if (reasoningEffort && reasoningEffort !== 'default') override.reasoning_effort = reasoningEffort;
    const raw = await context.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { includePreset: false, includeInstruct: false, signal, extractData: false },
        override,
    );
    const usage = readUsage(raw);
    const finishReason = raw?.choices?.[0]?.finish_reason ?? raw?.choices?.[0]?.native_finish_reason ?? null;
    // Anthropic-shaped answers (Claude sources) carry structured output as a tool call.
    const toolInput = Array.isArray(raw?.content) ? raw.content.find((part) => part?.type === 'tool_use')?.input : null;
    const content = toolInput && typeof toolInput === 'object' ? toolInput : parseJsonAnswer(messageText(raw));
    if (!content || !Object.keys(content).length) {
        const why = finishReason === 'length' || finishReason === 'MAX_TOKENS'
            ? `its answer was cut off at the ${maxTokens}-token limit${usage?.reasoningTokens ? ` (${usage.reasoningTokens} tokens went to hidden thinking)` : ''}`
            : 'its answer was empty or not valid JSON';
        const error = new Error(`${label} returned no usable data: ${why}.`);
        error.usage = usage;
        throw error;
    }
    return { content, usage, finishReason };
}

/**
 * Whether the profile's route supports prompt caching we can ask for: OpenRouter serving a Gemini
 * or Claude model. Elsewhere the plain request is sent unchanged.
 */
export function cacheableProfile(context, profileId) {
    const profile = (context?.extensionSettings?.connectionManager?.profiles || []).find((p) => p?.id === profileId);
    return Boolean(profile && profile.api === 'openrouter' && /^(google\/gemini|anthropic\/claude)/.test(String(profile.model || '')));
}

/**
 * The system message marked as a cache breakpoint (OpenRouter's cache_control). The parser's rules
 * are the same for every reply - about half of its prompt - so a reply within five minutes of the
 * last one reads them from the cache at a quarter of the input price. Pure.
 */
export function withCachedSystem(messages) {
    return messages.map((m, i) => (m.role === 'system' && i === messages.findIndex((x) => x.role === 'system') && typeof m.content === 'string'
        ? { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
        : m));
}

/** Adds up several usage reports (null-safe). */
export function addUsage(...reports) {
    const out = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, cost: 0, knownCost: 0, unpriced: 0, calls: 0 };
    let costKnown = true;
    for (const r of reports.flat()) {
        if (!r) continue;
        out.calls += r.calls || 1;
        out.promptTokens += r.promptTokens || 0;
        out.completionTokens += r.completionTokens || 0;
        out.reasoningTokens += r.reasoningTokens || 0;
        out.cachedTokens += r.cachedTokens || 0;
        if (r.cost === null || r.cost === undefined) {
            costKnown = false;
            // Calls of a sum that never reported a price (1.07 showed the sum of the others as if it were the total).
            out.unpriced += (r.unpriced ?? (r.calls || 1));
            out.knownCost += r.knownCost || 0;
        } else {
            out.cost += r.cost;
            out.knownCost += r.knownCost ?? r.cost;
            out.unpriced += r.unpriced || 0;
        }
    }
    if (!costKnown) out.cost = null;
    return out.calls ? out : null;
}

/** "3,412 in / 1,380 out (212 thinking) tokens, $0.0061" */
export function formatUsage(usage) {
    if (!usage) return 'no usage reported';
    const n = (v) => (v === null || v === undefined ? '?' : Number(v).toLocaleString('en-US'));
    const thinking = usage.reasoningTokens ? ` (${n(usage.reasoningTokens)} thinking)` : '';
    const cached = usage.cachedTokens ? ` (${n(usage.cachedTokens)} cached)` : '';
    const cost = usage.cost === null || usage.cost === undefined ? '' : `, $${usage.cost.toFixed(4)}`;
    const calls = usage.calls > 1 ? ` over ${usage.calls} calls` : '';
    return `${n(usage.promptTokens)} in${cached} / ${n(usage.completionTokens)} out${thinking} tokens${cost}${calls}`;
}
