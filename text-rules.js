// Word rules shared by the storyboard completion (scene-parser.js) and the prompt compiler
// (prompt-builder.js). The image model draws every thing a sentence names and reads every sentence
// literally, so these decide how far away a person is, what a body is doing, and which words must not
// reach the prompt at all. Pure.

/** Words that put a person far from the main figures (a background far away, not across the table). */
export const FAR_WORDS = /\b(?:in the distance|distant|far away|far off|further (?:away|off|back|down|up)|at the far (?:end|side)|far end|far side|down the (?:street|road|hall|hallway|corridor|platform|alley|lane|path|block)|across the (?:room|hall|street|square|plaza|courtyard|field|road|platform|station|tavern|bar|café|cafe|restaurant|lobby|office|yard|market)|behind the (?:counter|bar)|at the (?:counter|bar)|by the (?:counter|bar)|in the background|blurred|silhouette|out of focus|small figure)\b/i;

/** Words that put the player in the near foreground of the frame (an over-the-shoulder view). */
export const FOREGROUND_WORDS = /\b(?:foreground|shoulder|back of (?:his|her|their) head|from behind|side of the frame|edge of the frame|torso|back turned to the viewer)\b/i;

/** Looking words in a clause about someone. */
export const LOOK_WORDS = /\b(?:look\w*|stare\w*|staring|glar\w*|watch\w*|gaz\w*|eye\w*|peer\w*|glanc\w*|meet\w* (?:his|her|their) eyes)\b/i;

export const SIT = /\b(?:sits?|sitting|seated|sat)\b/i;
export const KNEEL = /\b(?:kneel\w*|knelt)\b/i;
export const LIE = /\b(?:lies|lying|lay|lays down|sprawl\w*)\b/i;
/** A body that is getting up or moving: a carried posture ends here. */
export const UP = /\b(?:stand\w*|stood|gets? up|getting up|rises?|rising|rose|jumps? up|springs? up|leaps?|leaping|leapt|walk\w*|strid\w*|pac(?:e|es|ing)\b|runs?|running|ran|jog\w*|march\w*|steps? (?:out|away|back|forward|off|into|through|inside|outside)|stepping|heads? (?:to|for|out|toward|towards|off)|heading|leav\w*|approach\w*|climb\w*|storm\w* (?:off|out)|turns? (?:on (?:her|his|their) heel|to leave))\b/i;

/** "seated" / "kneeling" / "lying" / null for a text about one body. Pure. */
export function postureOf(text) {
    const t = String(text || '');
    if (SIT.test(t)) return 'seated';
    if (KNEEL.test(t)) return 'kneeling';
    if (LIE.test(t)) return 'lying';
    return null;
}

/** The words for a posture carried into a frame that does not state one. Pure. */
export function postureWords(posture) {
    // "still seated" lost to "leans over the table, hands in pockets" (drawn standing, live test
    // 2026-10-01): the seat itself is named, so the pose has something to sit on.
    return { seated: 'still sitting on the chair', kneeling: 'still kneeling', lying: 'still lying down' }[posture] || '';
}

/** The sentences of a text (split at ".", ";", "!" and "?"). Pure. */
export function sentencesOf(text) {
    return String(text || '').split(/(?<=[.;!?])\s+|;\s*/).map((c) => c.trim().replace(/[.;]$/, '')).filter(Boolean);
}

/** The clauses of a background or description line (split at ";", ". " and ", <Name>"). Pure. */
export function clausesOf(text) {
    return String(text || '')
        .split(/;\s*|\.\s+|,\s+(?=(?:and\s+|while\s+)?(?:the\s+|a\s+|an\s+)?\p{Lu})|,\s+(?=with\s)/u)
        .map((c) => c.trim().replace(/\.$/, ''))
        .filter(Boolean);
}

// A camera direction the director wrote into what happens ("Seen past Alex's shoulder, ..."): the
// frame's camera says it already, and when the frame is cut or redrawn with another camera the words
// contradict it ("Seen past the viewer's shoulder" in a first-person view).
const CAMERA_CLAUSE = /^(?:(?:an?\s+)?(?:extreme close-up|close-up|medium shot|wide shot|full shot|low-angle shot|high-angle shot)\s+(?:on|of)\s+|(?:seen|viewed|shown|framed|captured|glimpsed|looking|pictured)\s+(?:past|over|from behind|from|through|across|beyond)\s+[^,]{1,70},\s*|(?:over|past|across)\s+[^,]{1,50}?\bshoulders?,\s*|from (?:behind|over|across)\s+[^,]{1,50},\s*|in the (?:near )?foreground,\s*|through (?:his|her|their|the viewer's|the player's) eyes,\s*|from (?:his|her|their|the viewer's|the player's) (?:point of view|perspective|viewpoint),\s*)/i;

/** The description without a leading camera direction. Pure. */
export function withoutCameraClause(text) {
    const t = String(text || '').trim();
    const out = t.replace(CAMERA_CLAUSE, '');
    return out === t ? t : out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Text without what it says is absent. At CFG 1 a negation draws what it names: "a face with no
 * scars" put scars on faces, "without looking" drew the look. The parts that state an absence go;
 * what is there stays. Pure.
 */
export function withoutAbsences(text) {
    let t = String(text || '');
    // "smooth face with no marks or scars" -> "smooth face"; "clean-shaven face without scars" -> "clean-shaven face"
    t = t.replace(/\s+(?:with\s+no|without|free of|devoid of|lacking)\s+(?:any\s+)?[\w-]+(?:\s+(?:or|and|nor)\s+[\w-]+)*(?:\s+[\w-]+)?(?=\s*(?:[,;.]|$))/gi, '');
    // whole list items that only state an absence: "no scars", "no facial marks", "without jewelry"
    t = t.split(/(,\s*)/).filter((part, i, all) => {
        if (/^,\s*$/.test(part)) return true;
        return !/^\s*(?:no|without|never|not|nothing|none)\b/i.test(part);
    }).join('').replace(/(?:,\s*){2,}/g, ', ').replace(/^\s*,\s*|\s*,\s*$/g, '');
    // action clauses: ", without turning her head" / "without blinking"
    t = t.replace(/,?\s*\bwithout\s+[\w-]+ing\b[^,.;]*/gi, '');
    // "ignoring the dish" stays; "not looking" / "does not look" cannot be said positively - leave it
    // to the director rule (write what is visible).
    return t.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
}

/** An outfit value that means nothing is worn / no outfit given. */
export const NO_OUTFIT = /^\s*(?:none|nothing|n\/a|-|no clothes|no clothing|naked|nude)\s*\.?\s*$/i;

const OUTER = /\b(?:jacket|coat|hoodie|cardigan|blazer|cloak|cape|overcoat|parka|windbreaker|trench|poncho|mantle|haori|kimono jacket|bomber|duster|shawl)\b/i;
const TOP = /\b(?:shirt|t-shirt|tee|top|blouse|tank|camisole|sweater|jumper|tunic|dress|vest|bodysuit|crop|polo|turtleneck|sweatshirt)\b/i;

/**
 * The outfit with its outer layer first: "tank top, shorts, choker, scrunchie, white jacket" drew no
 * jacket in any frame (the last item of a long list is dropped); "white jacket over a tank top, ..."
 * is how the layers are worn. Pure.
 */
export function layeredOutfit(outfit) {
    const items = String(outfit || '').split(/,\s*/).map((t) => t.trim()).filter(Boolean);
    const outer = items.findIndex((t) => OUTER.test(t) && !/\b(?:over|under|tied|around (?:the|her|his) waist|carried|slung|folded)\b/i.test(t));
    if (outer <= 0) return items.join(', ');
    const top = items.findIndex((t, i) => i !== outer && TOP.test(t) && !OUTER.test(t));
    const rest = items.filter((_, i) => i !== outer && i !== top);
    const lower = (t) => t.replace(/^(\p{Lu})(?=\p{Ll})/u, (c) => c.toLowerCase());
    const head = top >= 0 ? `${items[outer]} worn over ${lower(items[top])}` : items[outer];
    return [head, ...rest].join(', ');
}

const MALE_WORDS = { he: 'he', him: 'him', his: 'his', himself: 'himself' };
const FEMALE_WORDS = { she: 'she', her: 'her', hers: 'hers', herself: 'herself' };

/**
 * Pronouns of a sex nobody drawn in the frame has point at someone outside it: "glaring at him" in
 * a first-person frame of a girl made the model add a man. They become "the viewer" when the player
 * (not drawn) has that sex, else "someone". Pure.
 * @param {string} text
 * @param {{drawn: Set<string>, viewerSex?: string|null}} who drawn: the sexes of the people drawn
 *   (main figures and named background people); viewerSex: the player's sex when the player is not drawn.
 */
export function withoutStrayPronouns(text, { drawn, viewerSex = null, known = [] }) {
    const t = String(text || '');
    if (!t || !drawn || drawn.has('other')) return t;
    if (!known.length) return strayIn(t, drawn, viewerSex);
    // A sentence that names someone who is not a main figure ("Alice sees Bob in the distance and smiles at
    // him") says whom its pronoun means: that person's sex counts as drawn for that sentence, so "him" stays
    // Bob and is not turned into the viewer (1.07 only looked at the main figures).
    return t.split(/(?<=[.!?])(\s+)/).map((part, i) => {
        if (i % 2) return part;
        const here = new Set(drawn);
        for (const k of known) {
            const named = (k.names || []).some((n) => String(n || '').trim().length > 1 && new RegExp(`(?<![\\p{L}\\p{N}])${String(n).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(part));
            if (named) here.add(k.sex === 'male' || k.sex === 'female' ? k.sex : 'other');
        }
        return here.has('other') ? part : strayIn(part, here, viewerSex);
    }).join('');
}

function strayIn(text, drawn, viewerSex) {
    let t = text;
    for (const [sex, words] of [['male', MALE_WORDS], ['female', FEMALE_WORDS]]) {
        if (drawn.has(sex)) continue;
        const who = viewerSex === sex ? 'the viewer' : 'someone';
        const whose = `${who}'s`;
        t = t.replace(new RegExp(`\\b(${Object.keys(words).join('|')})\\b(\\s+[\\w'-]+)?`, 'gi'), (m, word, next = '') => {
            const w = word.toLowerCase();
            const cap = (s) => (word[0] === word[0].toUpperCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s);
            if (w === 'he' || w === 'she') return `${cap(who)}${next}`;
            if (w === 'himself' || w === 'herself') return `${cap(who)}${next}`;
            if (w === 'him') return `${cap(who)}${next}`; // "him" is only ever an object (1.07: "hands him a cup" -> "the viewer's a cup")
            if (w === 'hers') return `${cap(whose)}${next}`;
            if (w === 'his') return `${cap(whose)}${next}`;
            // "her": possessive before a noun ("her face"), object otherwise ("at her", "her.", "gives her a cup")
            const after = String(next).trim().toLowerCase();
            const objectNext = !after || /^(?:a|an|the|some|another|one|and|or|but|as|while|with|to|at|in|on|from|for|into|toward|towards|across|over|back|away|up|down|out|off|again|too|now|then|before|after|because|so|if|when|who|that|which)$/.test(after);
            return objectNext ? `${cap(who)}${next}` : `${cap(whose)}${next}`;
        });
    }
    return t;
}

/** Things that stand between two people: dropped from a scene where two people talk face to face. */
const DIVIDER = /\b(?:partitions?|dividers?|room dividers?|privacy screens?|folding screens?|booth walls?|booth partitions?|lattice screens?|shoji screens?)\b/i;

/** A list of scenery without the dividers in it ("café interior with wooden partitions and pendant lights" -> "café interior and pendant lights"). Pure. */
export function withoutDividers(text) {
    const t = String(text || '');
    if (!DIVIDER.test(t)) return t;
    const parts = t.split(/(,\s*|\s+and\s+|\s+with\s+)/i);
    const out = [];
    for (let i = 0; i < parts.length; i += 2) {
        if (DIVIDER.test(parts[i])) continue;
        out.push(out.length ? `${parts[i - 1] || ', '}${parts[i]}` : parts[i]);
    }
    return out.join('').trim();
}

/** Glass in a room where two people face each other is drawn as a pane between them. */
const GLASS = /\b(?:windows?|window-?panes?|panes?|plate-?glass|glass(?:\s+(?:walls?|doors?|panels?|partitions?|facades?|fronts?|safety doors?))?|reflections? on (?:the )?glass|storefront glass)\b/i;

/**
 * Scenery without its windows and glass, for a frame of two people face to face. "large plate-glass
 * window ... neon reflections on glass" was drawn as a glass pane standing between the two, on every
 * seed (8 of 8); without those words, 0 of 4 (A/B 2026-10-01). The room is still the room. Pure.
 */
export function withoutGlass(text) {
    let t = String(text || '');
    if (!GLASS.test(t)) return t;
    t = t.replace(/\s+(?:by|near|beside|next to|at|along|in front of)\s+(?:the|a|an)\s+(?:[\w-]+\s+){0,2}?(?:window|windows|glass)\b/gi, '');
    const parts = t.split(/(,\s*|\s+and\s+|\s+with\s+)/i);
    const out = [];
    for (let i = 0; i < parts.length; i += 2) {
        if (GLASS.test(parts[i])) continue;
        out.push(out.length ? `${parts[i - 1] || ', '}${parts[i]}` : parts[i]);
    }
    return out.join('').trim();
}
