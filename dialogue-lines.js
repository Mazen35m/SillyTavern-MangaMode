// Balloon text cut in code, not by the scene parser.
//
// The parser used to copy every spoken line into its answer, cut into balloon-sized pieces. That
// copy was about a third of its output tokens - and output is what a parse costs (Gemini 3.8 Flash:
// $3.75 per million out vs $0.75 in). Quoted speech is now found and cut here; the parser only
// says who says each numbered piece, how, and in which frame. The words in the balloons are
// therefore always exactly the words of the reply.
//
// Replies with no quotation marks at all (some cards write speech bare, actions in *asterisks*)
// keep the old way: the parser extracts and cuts the lines itself.
import { splitLongLine } from './bubbles.js';

const QUOTE = /“([^”]*)”|"([^"\n]*)"|«([^»]*)»|「([^」]*)」|『([^』]*)』/g;

function words(text) {
    return String(text).trim().split(/\s+/).filter(Boolean).length;
}

/** Markdown markers out, whitespace tidied. */
function clean(text) {
    return String(text).replace(/[*_~`]+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * One quoted passage cut into balloons: sentence by sentence, short neighbours joined, a long
 * sentence cut at a natural boundary. An ellipsis followed by a lower-case word is a pause inside
 * a thought, not a sentence end. Pure.
 * @returns {string[]}
 */
export function segmentSpeech(passage) {
    const text = clean(passage);
    if (!text) return [];
    const sentences = text.split(/(?<=[.!?…]["'’”)\]]?)\s+(?=[^a-z\s])/).map((s) => s.trim()).filter(Boolean);
    const pieces = [];
    for (const sentence of sentences) {
        const last = pieces[pieces.length - 1];
        // A lone short exclamation ("Personal space!") is a balloon of its own - a Gemini-style
        // page letters those big and alone. Other short bits join their neighbour.
        const punchy = (t) => /[!?]$/.test(t) && words(t) <= 3;
        if (last !== undefined && !punchy(last) && !punchy(sentence)
            && (words(last) < 5 || words(sentence) < 4) && words(last) + words(sentence) <= 16) {
            pieces[pieces.length - 1] = `${last} ${sentence}`;
        } else {
            pieces.push(sentence);
        }
    }
    return pieces.flatMap((piece) => (words(piece) > 20 ? splitLongLine(piece, 18) : [piece]));
}

/**
 * Every quoted passage of a reply, cut into numbered balloons, in reading order.
 * `aside` marks a quote inside an *action* span (often a title or a quoted word, not speech).
 * @returns {{text: string, passage: number, aside: boolean}[]}
 */
// A character's thoughts written between backticks (`Strange clothes... a mage?`), the way many
// cards mark inner monologue. They are the reply's own words, so they are cut in code like quotes
// and drawn as thought balloons - the parser used to rewrite them into 2-6 words of its own.
const THOUGHT = /`([^`\n]+)`/g;

/**
 * Whether what stands between two quotes lets the second one continue the first. An action in asterisks
 * does ("Here," *she shoves the glass* "Drink it."); a speaker tag that ends a sentence, or a new line,
 * does not: "Hey," Bob said.\n"you came," Alice said - two speakers - was one balloon "Hey, you came,".
 */
function sameSentence(gap) {
    const outside = String(gap || '').replace(/\*[^*]*\*/g, ' ').trim();
    if (!outside) return !/\n\s*\n/.test(String(gap || ''));
    if (/\n/.test(outside)) return false;
    return !/[.!?…]["'”’)]?$/.test(outside);
}

export function extractSpeechLines(messageText) {
    const text = String(messageText || '');
    const out = [];
    let passage = 0;
    const spans = [
        ...[...text.matchAll(QUOTE)].map((m) => ({ index: m.index, end: m.index + m[0].length, body: m.slice(1).find((g) => g !== undefined) || '', thought: false })),
        ...[...text.matchAll(THOUGHT)].map((m) => ({ index: m.index, end: m.index + m[0].length, body: m[1], thought: true })),
    ].sort((a, b) => a.index - b.index)
        // A quote inside a backtick thought belongs to the thought.
        .filter((span, i, all) => span.thought || !all.some((t) => t.thought && t.index < span.index && span.index < t.index + t.body.length + 2));
    let previousEnd = -1;
    for (const match of spans) {
        const gap = previousEnd >= 0 ? text.slice(previousEnd, match.index) : '';
        previousEnd = match.end ?? match.index;
        const body = match.body;
        if (!/[\p{L}\p{N}]/u.test(body)) continue;
        if (match.thought) {
            for (const piece of segmentSpeech(body)) out.push({ text: piece, passage, aside: false, thought: true });
            passage++;
            continue;
        }
        const before = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index);
        const aside = ((before.match(/\*/g) || []).length % 2) === 1;
        const pieces = segmentSpeech(body);
        // "First of all," *she says, counting on a finger* "your cadence is wrong." - a sentence
        // interrupted by an action: its short opening joins the rest instead of a 3-word balloon.
        const last = out[out.length - 1]?.thought ? undefined : out[out.length - 1];
        // A trailing comma or dash means the sentence goes on after the action ("Here," *she
        // shoves the glass at you* "Drink it.") whatever the case of the next word.
        // Before a capital, only a one-word opener joins, once ("Here," + "Drink it.");
        // chaining "Yeah," + "That's him," + "And that..." read as one run-on balloon.
        const lower = /^[a-z]/.test(pieces[0] || '');
        const unfinished = last && (lower ? !/[.!?…]$/.test(last.text) : (/[,—–-]$/.test(last.text) && words(last.text) === 1 && !last.joined));
        if (unfinished && sameSentence(gap) && !aside && !last.aside && pieces.length && words(last.text) < 5 && words(last.text) + words(pieces[0]) <= 18) {
            last.text = `${last.text} ${pieces.shift()}`;
            last.joined = true;
        }
        for (const piece of pieces) out.push({ text: piece, passage, aside });
        passage++;
    }
    return out.map(({ joined, ...line }) => line);
}

/** The numbered list shown to the parser. */
export function formatSpeechLines(lines) {
    return lines.map((line, i) => `L${i}${line.thought ? ' (thought)' : ''}: ${line.text}`).join('\n');
}

/**
 * Turns the parser's numbered dialogue back into full entries and re-points every beat's
 * dialogue_indices at the new list. Lines marked "none" (a title, a quoted word) are dropped;
 * numbered lines the parser skipped are put back in order - a balloon is never lost; an unlisted
 * line (an inner thought) keeps its place after the line before it. Pure; returns a new scene.
 */
export function resolveDialogueRefs(scene, lines, { fallbackSpeaker = '' } = {}) {
    const raw = Array.isArray(scene?.dialogue) ? scene.dialogue : [];
    const used = new Set();
    const dropped = new Set();
    const items = [];
    let lastKey = -1;
    let order = 0;
    raw.forEach((d, oldIndex) => {
        const n = Number(d?.line);
        const listed = Number.isInteger(n) && n >= 0 && n < lines.length;
        if (listed) {
            if (used.has(n) || dropped.has(n)) return;
            if (d.bubble_type === 'none') { dropped.add(n); return; }
            used.add(n);
            lastKey = Math.max(lastKey, n);
            const type = lines[n].thought ? 'thought' : (d.bubble_type === 'thought' ? 'speech' : (d.bubble_type || 'speech'));
            items.push({ key: n, order: order++, oldIndex, entry: { speaker: String(d.speaker || ''), text: lines[n].text, bubble_type: type } });
        } else if (String(d?.text || '').trim()) {
            items.push({ key: lastKey + 0.5, order: order++, oldIndex, entry: { speaker: String(d.speaker || ''), text: clean(d.text), bubble_type: d.bubble_type === 'none' ? 'speech' : (d.bubble_type || 'speech') } });
        }
    });
    lines.forEach((line, n) => {
        if (used.has(n) || dropped.has(n)) return;
        // A skipped quote inside an action span is most likely not speech; leave it out.
        if (line.aside) return;
        items.push({ key: n, order: order++, oldIndex: null, entry: { speaker: '', text: line.text, bubble_type: line.thought ? 'thought' : 'speech' } });
    });
    items.sort((a, b) => a.key - b.key || a.order - b.order);
    // A put-back line gets the speaker of the same quoted passage, else of the line before it.
    items.forEach((item, i) => {
        if (item.entry.speaker) return;
        const passage = Number.isInteger(item.key) ? lines[item.key]?.passage : null;
        const sibling = items.find((o) => o !== item && o.entry.speaker && Number.isInteger(o.key) && lines[o.key]?.passage === passage);
        item.entry.speaker = sibling?.entry.speaker || items.slice(0, i).reverse().find((o) => o.entry.speaker)?.entry.speaker || fallbackSpeaker;
    });
    const newIndex = new Map(items.filter((it) => it.oldIndex !== null).map((it, _i, arr) => [it.oldIndex, items.indexOf(it)]));
    const remap = (indices) => (Array.isArray(indices) ? indices.map((i) => newIndex.get(Number(i))).filter((i) => i !== undefined) : []);
    return {
        ...scene,
        dialogue: items.map((it) => it.entry),
        beats: Array.isArray(scene?.beats) ? scene.beats.map((b) => ({ ...b, dialogue_indices: remap(b?.dialogue_indices) })) : scene?.beats,
    };
}
