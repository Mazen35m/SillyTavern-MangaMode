// What is kept on a message when a (re)draw fails. Pure.

/**
 * A failed run must not destroy a good picture: starting a redraw replaces the saved result with a
 * "generating" placeholder, and the failure used to leave only an error (the images were lost).
 * @param {object|null} previous The last good result (status "done" with panels), if the message had one.
 * @param {object} failedRun The result the failed run produced (status "error").
 * @returns {object} the old result with `lastError`, or `failedRun` itself when there is nothing to keep.
 */
export function keepLastGood(previous, failedRun) {
    const hadPictures = previous?.status === 'done' && ((Array.isArray(previous.panels) && previous.panels.length) || previous.imageUrl);
    if (!hadPictures || failedRun?.status !== 'error') return failedRun;
    return {
        ...previous,
        // What the failed run cost is still spent: it goes into the ledger of the kept result.
        usage: failedRun.usage?.ledger ? { ...(previous.usage || {}), ledger: failedRun.usage.ledger } : previous.usage,
        lastError: { message: failedRun.error || 'unknown error', paramsHash: failedRun.paramsHash || null, usage: failedRun.usage || null, at: new Date().toISOString() },
    };
}

// ---------------------------------------------------------------- what a chat has cost

const entryOf = (usage, at) => {
    const t = usage?.total;
    if (!t || !(t.calls > 0)) return null;
    const priced = Number.isFinite(t.cost);
    return {
        at,
        cost: priced ? t.cost : (Number.isFinite(t.knownCost) ? t.knownCost : 0),
        // Calls whose price the provider did not report: their cost is NOT in `cost`.
        unpriced: priced ? (t.unpriced || 0) : (Number.isFinite(t.unpriced) ? t.unpriced : t.calls),
        calls: t.calls,
        redraw: Boolean(usage.redrawn),
    };
};

/**
 * The usage of a reply with every attempt kept. 1.07 stored only the last run's cost per message, so a
 * redraw REPLACED the cost of the attempt before it and the chat total went down after a paid attempt.
 * Each run (success, failure or redraw) now adds one entry to an append-only ledger. Pure.
 * @param {object|null} priorUsage The usage already saved with the message (with or without a ledger).
 * @param {object|null} runUsage What this run cost (usageSummary()).
 */
export function withLedger(priorUsage, runUsage, at = new Date().toISOString()) {
    // A reply saved by 1.07 has no ledger: its one total is the first entry.
    const prior = Array.isArray(priorUsage?.ledger) ? priorUsage.ledger : [entryOf(priorUsage, null)].filter(Boolean);
    const entry = entryOf(runUsage, at);
    const ledger = entry ? [...prior, entry] : prior;
    return runUsage ? { ...runUsage, ledger } : (ledger.length ? { ledger } : null);
}

/** What one reply cost over all its attempts: known money, calls without a reported price, attempts. Pure. */
export function spentOf(usage) {
    const ledger = Array.isArray(usage?.ledger) ? usage.ledger : [entryOf(usage, null)].filter(Boolean);
    return {
        known: ledger.reduce((sum, e) => sum + (Number.isFinite(e.cost) ? e.cost : 0), 0),
        unpriced: ledger.reduce((sum, e) => sum + (e.unpriced || 0), 0),
        attempts: ledger.length,
    };
}

/** What the whole chat cost: the sum over every reply's ledger. null when nothing was spent or reported. Pure. */
export function chatSpent(chat) {
    let known = 0;
    let unpriced = 0;
    let any = false;
    for (const m of chat || []) {
        const usage = m?.extra?.manga?.usage;
        if (!usage) continue;
        const s = spentOf(usage);
        if (s.attempts) any = true;
        known += s.known;
        unpriced += s.unpriced;
    }
    return any ? { known, unpriced } : null;
}
