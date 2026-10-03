// The cast book: one fixed look per person, for the whole story.
//
// Side characters used to be described afresh in every frame - the guard of one reply was a man in
// a tunic, a knight in plate, then a copy of the player in a black T-shirt. Now every person gets a
// label, a permanent look and a current outfit the first time they appear (from the world book for
// the player, the card and lorebook characters; from the parser for anyone new), and every later
// frame draws them from that entry. The look never changes once set; the outfit changes only when a
// reply says so (armour taken off, a disguise put on) and then stays changed. Read from the chat's
// own saved scenes, like the set book, so there is no second store to drift.

function words(text) {
    return (String(text || '').toLowerCase().replace(/['’]s\b/g, '').match(/[\p{L}\p{N}]+/gu) || []);
}

function norm(name) {
    return words(name).join(' ');
}

const TITLE = new Set(['guard', 'sir', 'lady', 'lord', 'captain', 'the', 'old', 'young', 'master', 'mister', 'miss', 'mr', 'mrs', 'ms', 'dr', 'doctor', 'father', 'sister', 'brother', 'king', 'queen', 'prince', 'princess', 'knight', 'dame', 'priest', 'mage']);

/** The title words of a normalised name ("old", "lady", "captain"...), without the article. */
function titlesOf(n) {
    return n.split(' ').filter((w) => TITLE.has(w) && w !== 'the');
}

/**
 * True when two names clearly mean the same person ("Guard Roland" / "Roland"). Pure.
 * Two DIFFERENT titles are two different people: "Old Merchant" / "Young Merchant", "Lord Harlan" /
 * "Lady Harlan", "Mr Smith" / "Mrs Smith" were merged by 1.07 because titles were thrown away before
 * comparing (one title against none is still the same person: "Guard Roland" / "Roland").
 */
export function sameName(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const tx = titlesOf(x);
    const ty = titlesOf(y);
    if (tx.length && ty.length && [...new Set(tx)].sort().join(' ') !== [...new Set(ty)].sort().join(' ')) return false;
    const core = (n) => n.split(' ').filter((w) => !TITLE.has(w));
    const cx = core(x);
    const cy = core(y);
    if (!cx.length || !cy.length) return false;
    const [short, long] = cx.length <= cy.length ? [cx, cy] : [cy, cx];
    return short.every((w) => long.includes(w));
}

/** The entry for a name (or one of its aliases) in a cast list. Pure. */
export function findPerson(cast, name) {
    return (cast || []).find((p) => sameName(p.name, name) || (p.aliases || []).some((a) => sameName(a, name))) || null;
}

/**
 * One outfit per person: a bible entry that lists a second one ("...; alternatively a deep red silk robe") made the image
 * model draw both (a robe over the blouse, even a second woman in the robe). The text before the alternative is the outfit.
 * Pure.
 */
export function oneOutfit(text) {
    const t = String(text || '').trim();
    const cut = t.search(/\s*[;,.]?\s+(?:alternatively|otherwise|or\s+(?:sometimes|alternatively|else)|sometimes|occasionally)\b/i);
    return (cut > 0 ? t.slice(0, cut) : t).replace(/[;,.\s]+$/, '').trim();
}

function clean(entry) {
    return {
        name: String(entry?.name || '').trim(),
        aliases: (entry?.aliases || []).map((a) => String(a || '').trim()).filter(Boolean),
        role: entry?.role || 'npc',
        sex: ['male', 'female', 'other'].includes(entry?.sex) ? entry.sex : 'other',
        label: stablePart(String(entry?.label || '').trim()),
        look: String(entry?.look || '').trim(),
        outfit: oneOutfit(entry?.outfit),
    };
}

/**
 * Adds one reply's cast entries to a cast list: a new person is added whole; a known person keeps
 * their label and look, gains any missing detail, and takes the new outfit only when the reply
 * marks it as changed (or they had none). Pure; returns a new list.
 */
export function mergeCast(known, fresh) {
    // What a person wore BEFORE a change in an earlier reply is not part of this reply (outfitBefore / outfitFromBeat
    // describe one reply only).
    const out = (known || []).map(({ outfitBefore, outfitFromBeat, ...p }) => ({ ...p, aliases: [...(p.aliases || [])] }));
    for (const raw of fresh || []) {
        const entry = clean(raw);
        if (!entry.name) continue;
        const have = findPerson(out, entry.name) || (String(raw?.same_as || '').trim() ? findPerson(out, raw.same_as) : null);
        if (!have) {
            out.push(entry);
            continue;
        }
        if (!sameName(have.name, entry.name) && !have.aliases.some((a) => sameName(a, entry.name))) have.aliases.push(entry.name);
        if (!have.label && entry.label) have.label = entry.label;
        if (!have.look && entry.look) have.look = entry.look;
        if (have.sex === 'other' && entry.sex !== 'other') have.sex = entry.sex;
        if (entry.outfit && (raw?.outfit_changed || !have.outfit)) {
            if (have.outfit && raw?.outfit_changed) {
                have.label = labelForOutfit(have.label, entry.outfit);
                have.takenOff = takenOff(have.outfit, entry.outfit);
                // The reply may change clothes in its middle: the frames before the change show the old outfit
                // (1.07 drew every frame of the reply in the last outfit, also those before the change).
                const from = Number(raw?.outfit_from_beat);
                if (Number.isInteger(from) && from > 0) { have.outfitBefore = have.outfit; have.outfitFromBeat = from; }
            }
            have.outfit = entry.outfit;
        }
    }
    return out;
}

// Words that describe a garment rather than name it ("polished steel breastplate" -> breastplate).
const GARMENT_ADJECTIVE = new Set(['steel', 'iron', 'leather', 'heavy', 'light', 'polished', 'riveted', 'dark', 'black', 'white', 'brown', 'grey', 'gray', 'blue', 'green', 'crimson', 'plain', 'simple', 'fitted', 'loose', 'long', 'short', 'worn', 'dented', 'sturdy', 'fine', 'rough', 'thick', 'cotton', 'linen', 'woolen', 'silk', 'matching', 'sheathed', 'sweat-darkened']);

/**
 * What a change of clothes took off: items of the old outfit none of whose garment words are in
 * the new one ("polished steel breastplate" after "blue gambeson, steel pauldrons"). The quality
 * check makes sure they are really gone (Anima tends to draw armour back on). Pure.
 */
export function takenOff(oldOutfit, newOutfit) {
    const now = String(newOutfit || '').toLowerCase();
    return String(oldOutfit || '').split(/,|;|\bover\b|\bwith\b|\band\b|\bunder\b/i)
        .map((t) => t.trim())
        .filter((item) => {
            const words = item.toLowerCase().split(/[^a-z-]+/).filter((w) => w.length >= 4 && !GARMENT_ADJECTIVE.has(w));
            return words.length > 0 && !words.some((w) => now.includes(w));
        });
}

/**
 * The label after a change of clothes: "the town guard in a steel breastplate" stops naming the
 * breastplate once it is off (the label goes into every frame, so a stale one draws the old
 * clothes). A clause that still fits the new outfit stays. Pure.
 */
export function labelForOutfit(label, outfit) {
    const m = String(label || '').match(/^(.*?\S)\s+(?:in|wearing|dressed in|clad in)\s+(.+)$/i);
    if (!m) return label;
    const now = String(outfit || '').toLowerCase();
    const words = m[2].toLowerCase().split(/[^a-z-]+/).filter((w) => w.length > 3);
    return words.length && words.every((w) => now.includes(w)) ? label : m[1];
}

/**
 * The story's cast as of `messageId`: the world book's people first, then every person earlier
 * replies introduced, with outfits as the latest reply left them. The player's persona always
 * carries the persona's own name. Pure.
 */
export function findKnownCast(chat, messageId, worldCast = [], { personaName = '' } = {}) {
    let cast = mergeCast([], (worldCast || []).map((p) => (p.role === 'player' && personaName
        ? { ...p, name: personaName, aliases: [...(p.aliases || []), p.name].filter((a) => !sameName(a, personaName)) }
        : p)));
    for (let i = 0; i < messageId; i++) {
        const scene = chat?.[i]?.extra?.manga?.scene;
        if (Array.isArray(scene?.cast)) cast = mergeCast(cast, scene.cast);
    }
    return uniqueLabels(cast);
}

// A label names someone for the whole story, so a passing pose ("the sprinting watchman", "the
// leaning guard") is dropped from it even when the director slips one in.
const POSE_WORD = /\b(sprinting|running|leaning|kneeling|standing|sitting|seated|crouching|charging|fleeing|fighting|shouting|screaming|yelling|crying|weeping|bleeding|wounded|injured|sleeping|lying|fallen|falling|walking|smiling|grinning|laughing|waiting|watching|hiding|panicked|panicking|startled|surprised|angry|furious|nervous|frightened|scared|terrified|stunned)\s+/gi;

// Clothes in a label ("the iron-armored town guard", "the swordswoman in silver armor") go into
// every frame and outweigh the outfit: the image model drew full plate for "iron-armored" when the
// outfit said a breastplate over cloth. The outfit already describes them.
const CLOTHES_WORD = /\b[\p{L}-]*(?:armou?red|armou?r-clad|clad|cloaked|robed|hooded|helmeted|caped|uniformed|suited|aproned|gloved|booted)\s+/giu;
const CLOTHES_CLAUSE = /\s+(?:in|wearing|dressed in|clad in|with)\s+(?:an?\s+|the\s+|his\s+|her\s+)?(?:[\p{L}-]+\s+){0,3}?(?:armou?r|plate|mail|cloak|robes?|hood|helmet|coat|jacket|shirt|t-shirt|dress|gown|uniform|tunic|apron|cap|hat|smock|doublet|vest|suit|clothing|clothes|boots|gloves|scarf|cape|veil|breastplate|gambeson)\b.*$/iu;

/** The label without passing poses, moods or clothes. Pure. */
export function stablePart(label) {
    const original = String(label || '').trim();
    const out = original.replace(POSE_WORD, '').replace(CLOTHES_CLAUSE, '').replace(CLOTHES_WORD, '').replace(/\s{2,}/g, ' ').trim();
    return /^(the|a|an)?$/i.test(out) || out.split(/\s+/).length < 2 ? original : out;
}

const ORDINALS = ['', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/**
 * Makes every label unique ("the guard" twice -> "the guard", "the second guard"). A label taken by an
 * earlier person - also one that was already written "the second guard" - is never given again (1.07 gave
 * "the second guard" to two people, and one of them was then dropped as a duplicate). Pure.
 */
export function uniqueLabels(cast) {
    const used = new Set();
    return cast.map((p) => {
        let label = p.label || `the ${p.sex === 'female' ? 'woman' : p.sex === 'male' ? 'man' : 'figure'}`;
        if (!/^(the|a|an)\b/i.test(label)) label = `the ${label}`;
        let candidate = label;
        for (let n = 2; used.has(candidate.toLowerCase()); n++) {
            candidate = label.replace(/^(?:the|a|an)\s+/i, `the ${ORDINALS[n - 1] || `${n}th`} `);
        }
        used.add(candidate.toLowerCase());
        return { ...p, label: candidate };
    });
}

/** The list the scene parser is shown. Pure. */
export function formatKnownCast(cast, { personaName = '' } = {}) {
    return (cast || []).map((p) => {
        const who = p.role === 'player' || (personaName && sameName(p.name, personaName)) ? ' (THE PLAYER)' : '';
        const aka = (p.aliases || []).length ? ` (also: ${p.aliases.join(', ')})` : '';
        return `- ${p.name}${aka}${who} [${p.sex}] ${p.label} | look: ${p.look || '(not stated)'} | wearing now: ${p.outfit || '(not stated)'}`;
    }).join('\n');
}
