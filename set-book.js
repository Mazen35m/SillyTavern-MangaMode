import { placeWords } from './util.js';

// The "set book": fixed looks for the places and recurring objects of a story.
//
// Each frame used to describe its place afresh ("porch steps", "wooden porch", "the cottage"), and
// the image model invented a different porch, garage and bike every time. The parser now names
// each place/object once, with a fixed look, the first time it appears; every later reply gets the
// list back ("known set") and reuses the names, and the prompt builder puts the fixed look into
// every frame that shows it. The book is read from the chat's own saved scenes, so there is no
// second copy of state to drift.

const STOP = new Set([
    'the', 'and', 'with', 'from', 'near', 'beside', 'outside', 'inside', 'front', 'back', 'side', 'her', 'his', 'their',
    'its', 'player', 'players', 'sunlit', 'sunny', 'bright', 'dark', 'old', 'small', 'big', 'little', 'large', 'hot',
    'afternoon', 'evening', 'morning', 'night', 'day', 'dusk', 'dawn', 'area', 'spot', 'place', 'edge', 'corner',
]);

function words(text) {
    return placeWords(text, STOP);
}

function key(name) {
    return words(name).join(' ');
}

/** What the entry is, without its name ("the tavern"): what the image prompt calls it. */
function labelOf(entry) {
    const label = String(entry?.label || '').trim();
    if (label) return /^(the|a|an)\b/i.test(label) ? label : `the ${label}`;
    return entry?.kind === 'object' ? 'the object' : 'the place';
}

/**
 * Every place/object named in earlier replies' scenes, oldest look first (a look never changes
 * once set). Pure.
 * @returns {{name: string, kind: string, look: string}[]}
 */
export function findKnownSet(chat, messageId, lookback = 80) {
    const byKey = new Map();
    const start = Math.max(0, messageId - lookback);
    for (let i = start; i < messageId; i++) {
        const entries = chat?.[i]?.extra?.manga?.scene?.places;
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const name = String(entry?.name || '').trim();
            const look = String(entry?.look || '').trim();
            const k = key(name);
            if (!name || !look || !k || byKey.has(k)) continue;
            byKey.set(k, { name, kind: entry.kind === 'object' ? 'object' : 'place', label: labelOf(entry), look });
        }
    }
    return [...byKey.values()];
}

/** Known entries plus the ones this reply introduced (a known name keeps its old look). Pure. */
export function mergeSet(known, fresh) {
    const out = [...(known || [])];
    const seen = new Set(out.map((e) => key(e.name)));
    for (const entry of fresh || []) {
        const name = String(entry?.name || '').trim();
        const look = String(entry?.look || '').trim();
        const k = key(name);
        if (!name || !look || !k || seen.has(k)) continue;
        seen.add(k);
        out.push({ name, kind: entry.kind === 'object' ? 'object' : 'place', label: labelOf(entry), look });
    }
    return out;
}

/** The place entry a beat's location refers to: the most shared words, at least one. Pure. */
export function matchPlace(location, entries) {
    const loc = new Set(words(location));
    if (!loc.size) return null;
    let best = null;
    let bestScore = 0;
    for (const entry of entries || []) {
        if (entry.kind === 'object') continue;
        const w = words(entry.name);
        const shared = w.filter((x) => loc.has(x)).length;
        const exact = key(entry.name) === [...loc].join(' ');
        const score = exact ? 100 : shared / Math.max(1, w.length);
        if (shared && score > bestScore) { best = entry; bestScore = score; }
    }
    return best;
}

/**
 * Recurring objects a frame's text mentions (by the last word of their name - "the player's
 * road bike" is found by "bike"). Pure.
 */
export function objectsIn(text, entries) {
    const have = new Set(words(text));
    return (entries || []).filter((entry) => {
        if (entry.kind !== 'object') return false;
        const w = words(entry.name);
        return w.length && have.has(w[w.length - 1]);
    });
}

/** The list the parser is shown. */
export function formatKnownSet(entries) {
    return (entries || []).map((e) => `- ${e.name} (${e.kind}, ${e.label || 'no label'}): ${e.look}`).join('\n');
}
