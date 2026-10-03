// Sentence repair for the Direct path: what the name -> label swap leaves behind in a moment.
//
// The reader writes a moment with names ("Anna", "the Travel Mug"); the code swaps every name for the story's fixed label
// ("the tall black-haired businesswoman", "the sleek travel mug"). A label carries its own article, so the words the reader
// put in front of the name break the sentence: "sleek black the designer sunglasses", "dim, cavernous the high-rise underground
// garage", "her black sleek black the sleek travel mug". This module repairs exactly that, in plain grammar, for every label:
//   - adjectives in front of a swapped label move behind its article ("the dim, cavernous high-rise underground garage");
//   - after a possessive or an article the label's own article is dropped ("her black travel mug");
//   - an adjective the label already says (or that the entry's own look says) is said once.
// It knows no image model and never adds a word that was not written: it only re-orders and de-duplicates.
// A word is moved only when it is clearly an adjective (a colour, material or size word, a word of the entry's own look, or an
// adjective ending after an article/preposition); a word that could be a verb ("holds", "carry") is never touched.

const ESC = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const COLOURS = 'black white red blue green yellow orange purple pink brown grey gray golden silver gold crimson scarlet navy teal beige ivory cream dark light pale bright dim';
const MATERIALS = 'wooden leather metal metallic steel iron glass plastic ceramic marble stone concrete silk cotton linen wool velvet paper brass copper chrome carbon';
const QUALITIES = 'sleek modern oversized large small tiny huge big little long short tall wide narrow thick thin heavy slim polished matte glossy shiny worn old new ancient vintage fancy elegant luxurious luxury cheap simple plain ornate cavernous spacious cramped shabby rusty dusty cozy warm cold hot cool soft hard rough smooth sharp round square narrow open closed empty full half-eaten wrapped folded sealed';
const ADJECTIVES = new Set(`${COLOURS} ${MATERIALS} ${QUALITIES}`.split(/\s+/));
// An adjective ending, trusted only right after an article, a possessive or a preposition (never after a subject: "they carry the ...").
const ADJECTIVE_ENDING = /^[\p{L}-]{4,}(?:ed|ful|ous|ive|ic|al|less|ish|ble|ant|ent|y)$/iu;
const DETERMINER = /^(?:the|a|an|this|that|these|those)$/i;
const POSSESSIVE = /^(?:his|her|their|its|my|your|our)$/i;
const FRIENDLY = /^(?:the|a|an|this|that|these|those|his|her|their|its|my|your|our|in|on|at|to|of|by|for|with|from|into|onto|over|under|near|behind|beside|toward|towards|against|across|through|past|along|around|and|but|or|as|while|when|then|than|like|after|before|until|inside|outside|between|beneath|above|below)$/i;

// Words that are never adjectives (a label's own look can contain "and" or "at": they must not be taken for descriptors).
const NOT_ADJECTIVE = /^(?:and|or|but|nor|so|yet|of|in|on|at|to|by|for|with|from|into|onto|over|under|near|behind|beside|toward|towards|against|across|through|past|along|around|inside|outside|between|beneath|above|below|as|while|when|then|than|like|after|before|until|if|is|are|was|were|be|been|being|has|have|had|do|does|did|not|no|all|both|each|some|any|other|another|one|two|three|he|she|it|they|him|her|them|his|its|their|my|your|our|we|you|i|who|whom|which|that|this|these|those|the|a|an|up|down|out|off|back|away|just|only|very|too|also)$/i;
const POSSESSIVE_S = /['’]s$/i;

const wordsOf = (s) => String(s || '').toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) || [];

/**
 * Repairs the sentence around every label that was swapped in. Pure.
 * @param {string} text the moment AFTER names were replaced by labels
 * @param {{label: string, own?: string}[]} entries every label that can occur (cast, places, objects); `own` = the entry's own look words
 */
export function repairLabelRuns(text, entries) {
    let out = String(text || '');
    const labels = (entries || []).filter((e) => /^(?:the|a|an)\s+\S/i.test(String(e?.label || '').trim()))
        .map((e) => ({ label: e.label.trim(), bare: e.label.trim().replace(/^(?:the|a|an)\s+/i, ''), own: new Set(wordsOf(`${e.label} ${e.own || ''}`)), sex: e.sex }))
        .sort((a, b) => b.label.length - a.label.length);
    for (const entry of labels) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${ESC(entry.label)}(?![\\p{L}\\p{N}])`, 'giu');
        let guard = 0;
        let m;
        while ((m = re.exec(out)) && guard++ < 20) {
            const fixed = repairOne(out, m.index, m[0].length, entry);
            if (!fixed) continue;
            out = fixed.text;
            re.lastIndex = fixed.next;
        }
    }
    return repeatedPossessives(out, labels.filter((e) => e.sex));
}

const POSSESSIVE_OF = { female: 'her', male: 'his', other: 'their' };

/**
 * "rests the curvaceous businesswoman's right hand" after the same person was already named in the sentence: the person's
 * own pronoun says it ("rests her right hand"). Skipped when another person of the same pronoun is in the sentence (it
 * could then mean either). Pure.
 */
export function repeatedPossessives(text, people) {
    if (!people?.length) return text;
    return String(text || '').split(/(?<=[.!?])\s+/).map((sentence) => {
        let out = sentence;
        for (const p of people) {
            const re = new RegExp(`(?<![\\p{L}\\p{N}])${ESC(p.label)}(?![\\p{L}\\p{N}])(['’]s)?`, 'giu');
            const found = [...out.matchAll(re)];
            if (found.length < 2) continue;
            const pronoun = POSSESSIVE_OF[p.sex] || 'their';
            const rivals = people.filter((q) => q !== p && (POSSESSIVE_OF[q.sex] || 'their') === pronoun && new RegExp(ESC(q.label), 'i').test(out));
            if (rivals.length) continue;
            let seen = 0;
            out = out.replace(re, (m, poss) => (++seen > 1 && poss ? pronoun : m));
        }
        return out;
    }).join(' ');
}

/** Tokens in front of `index`: [{word, comma, start}], nearest last; stops at a sentence break. */
function tokensBefore(text, index, max = 6) {
    const tokens = [];
    let end = index;
    while (tokens.length < max) {
        const m = /([\p{L}][\p{L}'-]*)(,?)(\s+)$/u.exec(text.slice(0, end));
        if (!m) break;
        const start = end - m[0].length;
        const sep = text.slice(0, start).match(/([.!?;:])\s*$/);
        tokens.unshift({ word: m[1], comma: m[2] === ',', start, end: start + m[1].length + m[2].length });
        end = start;
        if (sep) break; // a sentence starts here
    }
    return tokens;
}

function repairOne(text, index, length, entry) {
    const tokens = tokensBefore(text, index);
    if (!tokens.length) return null;
    // The run of adjectives directly in front of the label, nearest first.
    const strong = (w) => ADJECTIVES.has(w.toLowerCase()) || entry.own.has(w.toLowerCase());
    let i = tokens.length - 1;
    const run = [];
    while (i >= 0) {
        const t = tokens[i];
        // A comma right in front of the label ends a clause: the word before it is not an adjective of the label.
        if (i === tokens.length - 1 && t.comma) break;
        const adjective = !NOT_ADJECTIVE.test(t.word) && !POSSESSIVE_S.test(t.word) && (strong(t.word) || ADJECTIVE_ENDING.test(t.word));
        if (!adjective) break;
        run.unshift(t);
        i--;
    }
    if (!run.length) return null;
    const w0 = i >= 0 ? tokens[i] : null;
    const allStrong = run.every((t) => strong(t.word));
    const friendly = !w0 || FRIENDLY.test(w0.word);
    // Only a run of clear adjectives, or any adjective-looking run in a place where a subject or verb cannot stand.
    if (!allStrong && !friendly) return null;
    // Only the very first word of the run may be a weak adjective, and only after a friendly word.
    const upper = /^\p{Lu}/u.test(run[0].word);
    const bareWords = new Set(wordsOf(entry.bare));
    const kept = run.filter((t) => !bareWords.has(t.word.toLowerCase()) && !entry.own.has(t.word.toLowerCase()));
    const adjectives = kept.map((t, k) => {
        const word = k === 0 && upper ? t.word.replace(/^./u, (c) => c.toLowerCase()) : t.word;
        return k < kept.length - 1 && t.comma ? `${word},` : word;
    }).join(' ');
    const label = text.slice(index, index + length);
    const runStart = run[0].start;
    let replacement;
    if (w0 && DETERMINER.test(w0.word)) {
        // "a modern black Designer Sunglasses": the reader's own article stays, the label's goes.
        const next = adjectives || entry.bare;
        const article = /^an?$/i.test(w0.word) ? (/^[aeiou]/i.test(next) ? w0.word.replace(/^an?$/i, (x) => (x === x.toUpperCase() ? 'AN' : 'an')) : 'a') : w0.word;
        // The article before the run is part of the text already: only the run and the label change.
        replacement = `${adjectives ? `${adjectives} ` : ''}${entry.bare}`;
        const prefix = text.slice(0, w0.start);
        const fixedArticle = /^an?$/i.test(w0.word) ? `${/^\p{Lu}/u.test(w0.word) ? article.replace(/^./, (c) => c.toUpperCase()) : article}` : w0.word;
        return { text: `${prefix}${fixedArticle} ${replacement}${text.slice(index + length)}`, next: prefix.length + fixedArticle.length + 1 + replacement.length };
    }
    if (w0 && (POSSESSIVE.test(w0.word) || POSSESSIVE_S.test(w0.word))) {
        replacement = `${adjectives ? `${adjectives} ` : ''}${entry.bare}`;
    } else {
        // Any other word in front (a verb, a preposition, nothing): the label keeps its article, the adjectives go behind it.
        const article = label.match(/^(?:the|a|an)/i)[0];
        const art = /^an?$/i.test(article) && adjectives ? (/^[aeiou]/i.test(adjectives) ? 'an' : 'a') : article;
        replacement = `${upper ? art.replace(/^./, (c) => c.toUpperCase()) : art} ${adjectives ? `${adjectives} ` : ''}${entry.bare}`;
    }
    const lead = text.slice(0, runStart);
    return { text: `${lead}${replacement}${text.slice(index + length)}`, next: lead.length + replacement.length };
}

/** A word the label repeats ("ceramic ceramic coffee cup") is said once; a word that follows itself directly is one word. Pure. */
export function saidOnce(text) {
    return String(text || '').replace(/(?<![\p{L}-])([\p{L}-]{3,})\s+\1(?![\p{L}-])/giu, '$1');
}
