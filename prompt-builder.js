// The frame compiler: one planned frame -> the prompt the image model reads.
//
// Every person is drawn from the cast book (label, look, current outfit), every place from the set
// book, and the era from the world book - the parser's frame only adds what happens in this frame
// (actions, faces, gaze, who is around). Names never reach the image model: each person and place
// is written as its visual label ("the armoured watchman", "the tavern"), which also binds each
// description to one figure. Nothing here decides how a story looks; it only turns the story's own
// books into a clean prompt, and keeps the prompt free of contradictions.
import { matchPlace, objectsIn } from './set-book.js';
import { PROMPT_STYLES } from './settings.js';
import { findPerson } from './cast-book.js';
import { cameraPhrase, cameraTags } from './director.js';
import { FAR_WORDS, sentencesOf, layeredOutfit, NO_OUTFIT, postureOf, withoutAbsences, withoutDividers, withoutGlass, withoutStrayPronouns } from './text-rules.js';

// ---------------------------------------------------------------- small text helpers

function capitalize(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const norm = (name) => String(name || '').trim().toLowerCase();

/** Text without its closing full stop (looks and outfits are joined into longer sentences). */
function bare(text) {
    return String(text || '').trim().replace(/[.;,\s]+$/, '');
}

/** A sentence with a full stop, or ''. */
function sentence(text) {
    // A clause cut by name swapping or speech removal can end on a comma ("Sits at the table,"):
    // the full stop used to be eaten by tidy() and two sentences ran together.
    const t = String(text || '').trim().replace(/\s+/g, ' ').replace(/[,;:\s]+$/, '');
    if (!t) return '';
    return /[.!?]$/.test(t) ? capitalize(t) : `${capitalize(t)}.`;
}

/** Tidies what name swapping and clause removal leave behind. Pure. */
export function tidy(text) {
    return String(text || '')
        .replace(/\b(the|a|an)\s+(the|a|an)\b/gi, (m, a, b) => (a[0] === a[0].toUpperCase() ? capitalize(b.toLowerCase()) : b.toLowerCase()))
        .replace(/\b(a|an|the|with|and|to|of|in|at|on|for|his|her|their|its|as|while)\s*([.,;:!?])/gi, '$2')
        .replace(/\s+([.,;:!?])/g, '$1')
        .replace(/([.,;:])(?:\s*[.,;:])+/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .replace(/([.!?]\s+)([a-z])/g, (m, p, c) => `${p}${c.toUpperCase()}`)
        .trim();
}

// Speech words make the image model draw balloons with fake letters (lettering is MangaMode's job).
// Only real speech verbs are removed, with the clause they head - never nouns and adjectives that
// look like them ("an authoritative demand", "a demanding glare", "snapped his neck").
const SPEECH_VERB = '(?:speaks?|speaking|spoke|says|saying|said|talks?|talking|talked|tells?|telling|told|asks?|asking|asked|replies|replying|replied|whispers?|whispering|whispered|shouts?|shouting|shouted|yells?|yelling|yelled|explains?|explaining|explained|announc(?:es|ing|ed)|chatting|chatted|conversation|monologue)'; // "chat" alone is a noun too ("chat notification bubbles")
const CLAUSE_STOP = '(?=[.;,]|\\s(?:as|while|and|then|before|after|on|in|at|near|beside|by|along|across|inside|outside|behind|under|toward|towards|into|onto|over|through|with)\\s|$)';
const SPEECH_CLAUSE = new RegExp(`(?:,?\\s*(?:while|as|and|then)\\s+(?:(?:he|she|they|it|I|you)\\s+)?)?\\b${SPEECH_VERB}\\b.*?${CLAUSE_STOP}`, 'gi');

/** Removes speech clauses, keeping the visible action. Pure. */
export function stripSpeech(text) {
    // "leans in close to frantically [whisper]": the verb goes, the "to frantically" it leaves goes too.
    const out = tidy(String(text || '').replace(SPEECH_CLAUSE, '').replace(TOPIC_TAIL, '').replace(/\s+(?:to|and|then)\s+\w+ly(?=\s*(?:[.,;]|$))/gi, ''));
    return out.replace(/^[,;.\s]+/, '').replace(/^(?:as|while|and|then)\s+/i, '').replace(/[,;:\s]+$/, '');
}
// What was said is also dropped with its topic ("tells her about the train").
const TOPIC_TAIL = /\s+(?:about|regarding|concerning|that)\b.*?(?=[.;,]|\s(?:as|while|and|then)\s|$)/gi;

/**
 * stripSpeech for text whose names are already labels. A label is a noun phrase with its own
 * prepositions ("the young man in the black t-shirt"): the clause stop inside it cut "talks to the
 * young man" and left "in the black t-shirt" on the SPEAKER (the armoured watchman was dressed in
 * the player's shirt). Labels are held out of the text while the clause is removed. Pure.
 */
export function stripSpeechSafe(text, pairs) {
    const labels = [...new Set((pairs || []).map((x) => x.label).filter(Boolean))].sort((a, b) => b.length - a.length);
    const held = [];
    let out = String(text || '');
    for (const label of labels) {
        out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(label)}(?![\\p{L}\\p{N}])`, 'giu'), (m) => { held.push(m); return `LBLZ${held.length - 1}ZZ`; });
    }
    out = stripSpeech(out);
    return out.replace(/LBLZ(\d+)ZZ/g, (m, i) => held[Number(i)] ?? m);
}

// ---------------------------------------------------------------- names -> visual labels

/**
 * Every name (and alias, and the core of a titled name: "Guard Roland" -> "Roland") of the cast and
 * the set book, paired with its visual label, longest first. Pure.
 */
export function namePairs(cast, setBook = []) {
    const pairs = [];
    const add = (name, label, core = false) => { if (String(name || '').trim().length >= 2) pairs.push({ name: String(name).trim(), label, core }); };
    for (const p of cast || []) {
        for (const n of [p.name, ...(p.aliases || [])]) {
            add(n, p.label);
            // The core of a titled name ("Guard Roland" -> "Roland"); a title alone ("Guard") is a
            // common noun too ("a guard stance") and is never swapped by itself. A descriptive name
            // made up for someone unnamed ("Town Guard", "Curious Townsman") has no core: its words
            // are ordinary words ("town", "curious") - it is recognised when one of them is in the
            // person's own label or description.
            const parts = String(n).split(/\s+/).filter((w) => /^[A-Z]/.test(w) && w.length >= 3 && !TITLE_WORDS.has(w.toLowerCase()));
            const own = `${p.label || ''} ${p.look || ''} ${p.outfit || ''}`.toLowerCase();
            const descriptive = parts.some((w) => new RegExp(`\\b${escapeRegex(w.toLowerCase())}`).test(own));
            if (!descriptive && (parts.length > 1 || (parts.length === 1 && parts[0] !== n))) for (const w of parts) add(w, p.label, true);
        }
    }
    for (const e of setBook || []) add(e.name, e.label || null);
    // A core word shared by two people is ambiguous - keep only the full names then.
    const counts = new Map();
    for (const { name, label } of pairs) {
        const k = norm(name);
        if (!counts.has(k)) counts.set(k, new Set());
        counts.get(k).add(label);
    }
    return pairs.filter(({ name }) => counts.get(norm(name)).size === 1)
        .sort((a, b) => b.name.length - a.name.length);
}

/** What a cast member who is NOT in this frame is called in the frame's text (see absentPairs). */
export const ABSENT_LABEL = 'someone';
export const VIEWER_LABEL = 'the viewer';

const TITLE_WORDS = new Set(['guard', 'sir', 'lady', 'lord', 'captain', 'the', 'old', 'young', 'master', 'mister', 'miss', 'doctor', 'father', 'sister', 'brother', 'king', 'queen', 'prince', 'princess', 'knight', 'dame', 'priest', 'mage', 'newspaper', 'boy', 'girl', 'man', 'woman']);

/**
 * Replaces every name (and "name's") with its label, in one pass - a label put in is never
 * matched again ("the armoured guard" must not have its "guard" swapped a second time). A place
 * without a label is left as its plain description. Pure.
 */
export function replaceNames(text, pairs) {
    const source = String(text || '');
    const usable = (pairs || []).filter((p) => p.label);
    let out = source;
    if (usable.length) {
        const byName = new Map(usable.map((p) => [p.name.toLowerCase(), p]));
        // An article (and one word) right before a name is swallowed: "the armored Town Guard" ->
        // "the iron-armored town guard", never "the armored the iron-armored town guard".
        const re = new RegExp(`(?<![\\p{L}\\p{N}])((?:the|a|an)\\s+(?:[\\p{L}-]+\\s+)?)?(${usable.map((p) => escapeRegex(p.name)).join('|')})(?![\\p{L}\\p{N}])('s)?`, 'giu');
        out = source.replace(re, (m, lead, name, poss, offset) => {
            const pair = byName.get(name.toLowerCase());
            // A core of a name ("Roland" of "Guard Roland") counts only written as a name.
            if (!pair || (pair.core && !/^\p{Lu}/u.test(name))) return m;
            // Somebody who is not in this picture stays nobody in particular: no article games.
            if (pair.label === ABSENT_LABEL || pair.label === VIEWER_LABEL) return `${pair.label}${poss || ''}`;
            let label = pair.label;
            const before = source.slice(Math.max(0, offset - 40), offset);
            if (!lead && /\b(his|her|their|its|this|that|our|my|your)\s+(?:[\p{L}-]+\s+)?$/iu.test(before)) label = label.replace(/^(the|a|an)\s+/i, '');
            if (lead) {
                const [article, word] = lead.trim().split(/\s+/);
                const bare = label.replace(/^(the|a|an)\s+/i, '');
                // Keep the word unless the label already says it ("armored" in "iron-armored").
                const said = word && new RegExp(`\\b${escapeRegex(word.toLowerCase().replace(/(ed|s)$/, ''))}`).test(bare.toLowerCase());
                const rest = `${word && !said ? `${word} ` : ''}${bare}`;
                const art = /^an?$/i.test(article) ? (/^[aeiou]/i.test(rest) ? 'an' : 'a') : article;
                label = `${/^\p{Lu}/u.test(article) ? capitalize(art) : art} ${rest}`;
            }
            return `${label}${poss || ''}`;
        });
    }
    out = tidy(out);
    return /^[A-Z]/.test(source.trim()) ? capitalize(out) : out;
}

// ---------------------------------------------------------------- looks and outfits

// Traits about the back of the body pulled the camera behind people and gave rear-view copies; a
// height or weight in numbers got lettered into the picture. Neither can be seen from the front.
const REAR_TRAIT = /\b(backside|butt|buttocks|bottom|rear|booty|ass|glutes|back view)\b/i;
const NUMBER_TRAIT = /\d+\s*(cm|centimet|mm|m\b|ft|feet|foot|inch|inches|in\b|kg|lbs?|pounds|'|")/i;

export function withoutRearTraits(text) {
    return String(text || '').split(',').map((t) => t.trim()).filter((t) => t && !REAR_TRAIT.test(t) && !NUMBER_TRAIT.test(t)).join(', ');
}

/** Booru-isms a sentence-reading model takes literally ("white skin" painted people chalk-white). */
function plainLook(text) {
    return withoutAbsences(withoutRearTraits(text)).replace(/\bwhite skin\b/gi, 'fair skin').replace(/\bpale skin\b/gi, 'fair, pale skin');
}

const FOOTWEAR = /\b(sneakers?|shoes?|boots?|sandals?|slippers?|heels|loafers|slip-ons?|flip-flops|socks|stockings|greaves|sabatons)\b/i;
const SHOES_OFF = new Set(['extreme close-up', 'close-up', 'medium shot']);

/**
 * The outfit as the image model should read it for this shot. Shoes in a waist-up shot pull the
 * camera back to show them. A printed shirt becomes a small image-only print (printed words came
 * out as gibberish lettering across the chest).
 */
export function framedOutfit(outfit, shot) {
    if (!outfit || NO_OUTFIT.test(String(outfit))) return '';
    let out = layeredOutfit(withoutAbsences(String(outfit)))
        .replace(/\b(?:band|slogan|logo)\s+(t-?shirt|tee|hoodie|sweatshirt)\b/gi, '$1 with a small picture print')
        .replace(/\b(?:band|slogan|logo|text)\s+(graphic|print|logo)\b/gi, 'picture print');
    // "a scrunchie on wrist" came out as one on each wrist.
    out = out.replace(/\b(on|around|round)\s+(?:her\s+|his\s+|their\s+)?wrist\b(?!s)/gi, '$1 one wrist');
    if (SHOES_OFF.has(String(shot || ''))) out = out.split(',').map((t) => t.trim()).filter((t) => t && !FOOTWEAR.test(t)).join(', ');
    return out;
}

// "boy" / "girl" / "teen" only as whole words: "cowboy hat", "tomboy" and "nineteen" (an adult) used
// to match and turned grown people into "a boy" / "a girl" in the prompt.
const YOUNG = /\b(?:boy|girl|kid|teen|teenager|youngster|youth|child|schoolboy|schoolgirl|toddler|infant)\b/i;
const AGE = /\b(\d{1,2})(?:\s*|-)(?:years?(?:\s*|-)old|yo)\b/i;
const YOUNG_AGE_WORDS = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)(?:\s*|-)years?(?:\s*|-)old\b/i;
const ADULT_AGE_WORDS = /\b(?:eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[\s-]+\w+)?(?:\s*|-)years?(?:\s*|-)old\b/i;

/** True when the look or label says the person is under 18 (a stated age, or boy/girl words). */
export function isYoung(person) {
    const text = `${person?.look || ''} ${person?.label || ''}`;
    const age = text.match(AGE);
    if (age) return Number(age[1]) < 18;
    if (YOUNG_AGE_WORDS.test(text)) return true;
    if (ADULT_AGE_WORDS.test(text)) return false;
    return YOUNG.test(text);
}

function nounOf(person) {
    const young = isYoung(person);
    if (person?.sex === 'female') return young ? 'a girl' : 'an adult woman';
    if (person?.sex === 'male') return young ? 'a boy' : 'an adult man';
    return young ? 'a young person' : 'an adult';
}

function pronouns(person) {
    if (person?.sex === 'female') return { He: 'She', him: 'her', his: 'her', looks: 'looks', faces: 'faces' };
    if (person?.sex === 'male') return { He: 'He', him: 'him', his: 'his', looks: 'looks', faces: 'faces' };
    return { He: 'They', him: 'them', his: 'their', looks: 'look', faces: 'face' };
}

// ---------------------------------------------------------------- camera

// Anything about legs or feet needs the whole body: "skids to a halt, boots scraping" framed at the
// waist gave a pair of disembodied legs in the foreground instead.
const LEG_PARTS = [
    // Running - but not "runs a hand through her hair", "a chill runs down her spine".
    String.raw`\b(?:run|runs|running|ran)\b(?!\s+(?:\w+\s+){0,2}(?:hands?|fingers?|fingertips?|thumbs?|palms?|eyes?|gaze|tongue|nails?|lips?|spines?|backs?|necks?|skin|cheeks?|faces?|arms?|temples?|brows?|foreheads?|hair|cold|deep|dry|late|low|wild|out|through (?:her|his|their) (?:mind|head)))`,
    String.raw`\bsprint\w*`,
    String.raw`\bdash(?:es|ed|ing)?\s+(?:to|toward|towards|into|out|off|across|past|away|for|up|down|through|after)\b`,
    String.raw`\bskid\w*`,
    String.raw`\bkick\w*`,
    String.raw`\b(?:kneel\w*|knelt|knees?)\b`,
    String.raw`(?<!(?:heart|stomach|pulse|spirits?)\s)\b(?:jump\w*|leap\w*)`,
    // Falling of a body - not a tear or hair ("falls down her cheek", "falls over one shoulder").
    String.raw`\b(?:falls?|falling|fell)\s+(?:\w+\s+)?(?:to|onto|down|over|back|backward|backwards|forward|off|into|flat|hard|from)\b(?!\s+(?:her|his|their|the|one|both|a)\s+(?:\w+\s+)?(?:cheeks?|face|shoulders?|eyes?|lap|chest|forehead|neck|arms?|back|hair))`,
    String.raw`\bstumbl(?:es|ed|ing)?\s+(?:back|forward|backward|backwards|to|into|over|out|down|across|along|away|off)\b(?!\s+(?:her|his|their|the)\s+(?:own\s+)?words)`,
    String.raw`\b(?:trips?|tripped|tripping)\s+(?:over|on|and)\b(?!\s+(?:her|his|their|the)\s+(?:own\s+)?words)`,
    String.raw`\bcrouch\w*|\bsquat\w*`,
    String.raw`\bwalk(?:s|ed|ing)?\b(?!\s+(?:him|her|them|you|me|us)\s+through)`,
    String.raw`\bstrid(?:e|es|ed|ing)\b`,
    String.raw`\bflee\w*|\bfled\b`,
    String.raw`\bcharg(?:es|ed|ing)\s+(?:at|toward|towards|into|forward|through|out|past|across|down)\b`,
    String.raw`\btiptoe\w*`,
    String.raw`\bpac(?:es|ed|ing)\s+(?:the|back|around|across|up|toward|towards)\b`,
    String.raw`\bfeet\b|\bfoot\b(?!\s+of\b)`,
    String.raw`(?<!(?:table|chair|desk|bed|stool|piano|counter)\s)\blegs?\b`,
    String.raw`\bboots?\b`,
];
const LEG_ACTION = new RegExp(LEG_PARTS.join('|'), 'i');

/** The camera actually used: a leg action in a waist-up shot becomes a full shot. Pure. */
export function effectiveCamera(spec, camera) {
    const cam = { shot: camera?.shot || 'medium shot', angle: camera?.angle || 'eye level', forCrop: camera?.forCrop };
    if (cam.forCrop || cam.shot !== 'medium shot' || spec?.kind === 'insert') return cam;
    const text = [spec?.description, ...(spec?.people || []).map((p) => p?.action)].join(' ');
    return LEG_ACTION.test(text) ? { ...cam, shot: 'full shot' } : cam;
}

// Hands on an object (or on someone) are lost when a close-up is cut to the face.
// Hands on an object or on someone. Only real hand words: "gives a small smile", "takes a deep
// breath", "releases a sigh" and "pays no attention" used to turn a face close-up into a waist-up shot.
const HAND_ACTION = /\b(?:hands?\s+(?:over|out|it|them|him|her)\b|handing\b|holds?\s+(?:out|up)\b|holding\s+(?:out|up)\b|pass(?:es|ing)?\s+(?:over|the|a|it|him|her|them)\b|grip\w*|grasp\w*|clutch\w*|fingers?\b|palms?\b|snatch\w*|shak\w*\s+hands|lets?\s+go\b|gives?\s+(?:him|her|them|it)\s+(?:the|a|an|his|her|their)\s+(?!(?:small|little|faint|slight|soft|warm|tiny|quick|brief|look|glance|stare|smile|smirk|nod|shrug|wink|grin|sigh)\b)|giving\s+(?:him|her|them|it)\s+(?:the|a|an))/i;

/**
 * The camera for a frame whose point is a contact between people or hands on an object: never a
 * face close-up (the crop would cut the hands away), a medium shot of both instead. Pure.
 */
export function contactCamera(spec, camera) {
    const shot = camera?.shot || 'medium shot';
    if (spec?.kind === 'insert' || spec?.kind === 'establishing' || shot !== 'close-up') return camera;
    const text = [spec?.interaction, ...(spec?.people || []).map((p) => p?.action)].join(' ');
    return String(spec?.interaction || '').trim() || HAND_ACTION.test(text) ? { ...camera, shot: 'medium shot' } : camera;
}

/** Booru framing tags put in front of a natural-language prompt (Anima keeps to them best). */
export const NATURAL_FRAMING = {
    'extreme close-up': 'portrait, close-up',
    'close-up': 'portrait, upper body',
    'medium shot': 'upper body, cowboy shot',
    'full shot': 'full body',
    'wide shot': 'wide shot',
};

/** The preset prefix with framing tags added to its tag list ("..., score_7." -> "..., score_7, full body."). */
export function withFramingTags(prefix, tags) {
    const p = String(prefix || '').trim();
    if (!tags) return p;
    if (!p) return `${tags}.`;
    return /[.,]$/.test(p) ? `${p.slice(0, -1)}, ${tags}.` : `${p}, ${tags}.`;
}

// ---------------------------------------------------------------- gaze

/**
 * Where a person looks, as a sentence. "Looks at the player" while the player is in the frame means
 * at HIM; with the player out of the frame it means straight at the viewer (the reader is the player).
 * Somebody who is not in the picture at all is "someone outside the picture" - naming him made the
 * image model draw him.
 */
export function gazeSentence(person, figures, { personaName = '', pov = false, overShoulder = false, swap = (t) => t, farAway = null, cast = null } = {}) {
    const gaze = String(person?.gaze || '').trim();
    if (!gaze) return '';
    const { He, looks, his } = pronouns(person.cast);
    let target = figures.find((f) => f !== person && refersTo(gaze, f, cast));
    // "The viewer" while the player is drawn in the picture (not over his shoulder) means the player:
    // a look at the reader there made people pose for the camera next to him.
    const persona = figures.find((f) => f !== person && personaName && norm(f.name) === norm(personaName));
    if (!target && persona && !overShoulder && VIEWER_WORD.test(gaze)) target = persona;
    // Toward whom the body turns: the person looked at, the viewer, or (for a glance back or past)
    // whatever the gaze names ("the guard by the apothecary").
    const behindPlayer = target && overShoulder && norm(target.name) === norm(personaName);
    const atViewer = behindPlayer || (!target && (VIEWER_WORD.test(gaze) || (personaName && sameAs(gaze, personaName))));
    const toward = atViewer ? 'the viewer' : target ? target.label : null;
    const turned = facingSentence(person, toward || 'the viewer', toward ? null : lowerArticle(swap(gaze).replace(/\.$/, '').replace(/^(?:at|toward|towards)\s+/i, '')));
    if (turned) return turned;
    if (target && overShoulder && norm(target.name) === norm(personaName)) return `${He} ${looks} toward the viewer.`;
    if (target) {
        // A person who holds something (a cup, a menu) was drawn looking down at it: the eyes go to
        // the other person's face.
        const holding = HOLDING.test(String(person.action || ''));
        return `${He} ${looks} at ${target.label}, ${his} eyes on that person's face${holding ? ', even while the hands are busy' : ''}.`;
    }
    const atPlayer = personaName && sameAs(gaze, personaName);
    // Someone further away in the picture (the player talking to someone down the street): the
    // watcher looks into the picture, not at the reader - onlookers were drawn posing at the viewer.
    const far = (farAway || []).find((p) => refersTo(gaze, { name: p.name, cast: p }, cast));
    if (far && !pov) return `${He} ${looks} away from the viewer, into the picture, toward ${far.label} further away.`;
    if (VIEWER_WORD.test(gaze) || atPlayer) return `${He} ${looks} straight at the viewer.`;
    // A cast member who is not in the picture (and not in its background): off to the side.
    const absent = (cast || []).find((c) => !figures.some((f) => f.cast === c) && refersTo(gaze, { name: c.name, cast: c }, cast));
    if (absent) return `${He} ${looks} off to one side, toward someone outside the picture.`;
    const where = lowerArticle(swap(gaze).replace(/\.$/, ''));
    return /^(at|toward|towards|down|up|away|off|over|past|into|out|sideways|to|around|back|through|ahead|forward|in|across|along|beyond)\b/i.test(where) ? `${He} ${looks} ${where}.` : `${He} ${looks} at ${where}.`;
}

/** "The grey watchman" inside a sentence -> "the grey watchman" (name swapping capitalises a leading label). */
function lowerArticle(text) {
    return String(text || '').replace(/^(The|A|An)\b(?=\s+[a-z])/, (a) => a.toLowerCase());
}

/**
 * A setting that lists "ceramic cups" as scenery put a second cup on the table when a person in
 * the frame is holding one: the plural scenery item is dropped when the same object is held.
 * Pure.
 */
export function withoutHeldProps(look, actionText) {
    const text = String(look || '');
    const actions = String(actionText || '');
    if (!text || !HOLDING.test(actions)) return text;
    return text.split(/,\s*/).filter((item) => {
        const last = (item.trim().match(/([a-z]+)$/i) || [])[1] || '';
        if (!/^[a-z]{3,}s$/i.test(last) || /ss$/i.test(last)) return true;
        const single = last.replace(/(ch|sh|x|s)es$/i, '$1').replace(/s$/i, '');
        return !new RegExp(`\\b${single}(?:s|es)?\\b`, 'i').test(actions) || item.trim().split(/\s+/).length > 4;
    }).join(', ');
}

// Something in the hands: the eyes then drift to it. Only used to keep the gaze on the other person.
const HOLDING = /\b(?:hold\w*|grip\w*|clutch\w*|cradl\w*|carr(?:y|ies|ying)|sip\w*|drink\w*|read\w*|study\w*|examin\w*|stir\w*|pour\w*|fiddl\w*|mix\w*|eat\w*|chew\w*|writ\w*|typ\w*|scroll\w*|text\w*|cup|mug|glass|menu|phone|book)\b/i;

/**
 * True when a text (a gaze, a description) names this figure: by name, alias, or a part of the name
 * used on its own ("Roland" for "Guard Roland", "Mira" for "Mira Hayashi"). Pure.
 */
export function refersTo(text, figure, cast = null) {
    const entry = figure?.cast;
    const names = [figure?.name, entry?.name, figure?.label, entry?.label, ...(entry?.aliases || [])].filter(Boolean);
    if (names.some((n) => sameAs(text, n))) return true;
    if (cast && entry) {
        for (const m of String(text || '').matchAll(/\p{Lu}[\p{L}'’-]{2,}/gu)) if (findPerson(cast, m[0]) === entry) return true;
    }
    return false;
}

/**
 * The name pairs of ONE frame. A person who is not drawn in it (not a figure, not seen far away in the
 * background) is written as "someone", the player as "the viewer": a label in the text is enough for
 * the image model to draw that person ("she hands the cup to the dark-haired young man" put him in a
 * frame about her). Pure.
 */
export function framePairs(pairs, cast, figures, { personaName = '', farAway = [] } = {}) {
    const drawn = new Set();
    for (const f of figures || []) { drawn.add(f.cast); drawn.add(findPerson(cast, f.name)); }
    for (const c of farAway || []) drawn.add(c);
    const player = personaName ? findPerson(cast, personaName) : null;
    const absent = new Map();
    for (const c of cast || []) {
        if (!c?.label || drawn.has(c)) continue;
        absent.set(c.label, c === player ? VIEWER_LABEL : ABSENT_LABEL);
    }
    if (player?.label && !absent.has(player.label) && !(figures || []).some((f) => f.cast === player)) absent.set(player.label, VIEWER_LABEL);
    return (pairs || []).map((pair) => (absent.has(pair.label) ? { ...pair, label: absent.get(pair.label) } : pair));
}

/** Known people the background text names: seen far away in the picture, not main figures. Pure. */
export function farAwayOf(spec, cast, figures) {
    return (cast || []).filter((c) => {
        if (figures.some((f) => f.cast === c || norm(f.name) === norm(c.name))) return false;
        const names = [c.name, ...(c.aliases || [])].filter(Boolean);
        const clause = sentencesOf(spec?.background || '').find((x) => names.some((n) => sameAs(x, n)));
        // Far only when the text says so: a person "seated across the table" named in the background
        // was sent "into the distance" (the director's background is anyone not in "people").
        return Boolean(clause) && FAR_WORDS.test(clause);
    });
}

/** Known people the background names (near or far): drawn in the picture, not main figures. Pure. */
export function backgroundPeopleOf(spec, cast, figures) {
    return (cast || []).filter((c) => !figures.some((f) => f.cast === c || norm(f.name) === norm(c.name))
        && [c.name, ...(c.aliases || [])].some((n) => n && sameAs(spec?.background || '', n)));
}

const His = (He) => ({ He: 'His', She: 'Her', They: 'Their' }[He]);
const VIEWER_WORD = /\b(viewer|camera|reader|you|player)\b/i;

// Which way a body faces follows what it does. The director often says "looks at the viewer" for
// someone walking away, looking back over a shoulder or glancing past - and "looks straight at the
// viewer" then turned the whole body toward the camera (she walked TOWARD us while leaving).
const LOOKS_BACK = /\b(?:looks?|looking|glanc\w*|peer\w*|calls?|calling|called)\s+back\b|\bover (?:her|his|their|the) shoulder\b|\b(?:twist\w*|turn\w*)\s+(?:her|his|their)\s+(?:head|torso|upper body|body|shoulders?)\s+back\b/i;
const WALKS_AWAY = /\b(?:walk\w*|strid\w*|march\w*|storm\w*|head\w*|stomp\w*|hurr\w*|rush\w*|runs?|running|sprint\w*|dash\w*|bolt\w*|flee\w*|fled|jog\w*|scurr\w*|stalk\w*|leav\w*)\s+(?:\w+\s+){0,3}?(?:away|off)\b|\bturns? on (?:her|his|their) heels?\b|\b(?:walk\w*|strid\w*|march\w*|head\w*)\s+(?:\w+\s+){0,3}?toward (?:the )?(?:exit|stairs|door|doorway)\b|\bwith (?:her|his|their) back to\b/i;
const LOOKS_PAST = /\b(?:eyes?|gaze|glance)\s+(?:\w+\s+){0,2}?(?:flick\w*|dart\w*|slid\w*|shift\w*|drift\w*|cut\w*)\b|\b(?:looks?|looking|peer\w*|glanc\w*|star\w*)\s+past\b|\bpast (?:the viewer|you|his shoulder|her shoulder|their shoulder)\b|\bavoid\w* (?:eye contact|his eyes|her eyes|their eyes|looking at)\b|\beyes (?:averted|shifted to the side|to the side)\b/i;
// Eyes lowered (to the lap, the floor, the hands): not "off to one side" - that drew a sideways pout
// for "her eyes drop to her lap" (Gemini review 2026-10-01).
const LOOKS_DOWN = /\bdowncast\b|\b(?:eyes|gaze)\s+(?:\w+\s+){0,2}?(?:lowered|drop\w*|fall\w*|fixed on (?:her|his|their) (?:lap|hands|feet)|on the (?:floor|ground|table))\b|\b(?:looks?|looking|stares?|staring|glanc\w*)\s+down\b|\blowers? (?:her|his|their) (?:eyes|gaze)\b/i;
const LOOKS_UP = /\b(?:up|upward|upwards)\b|\bthrough (?:her|his|their) (?:bangs|lashes|fringe)\b/i;

/**
 * The body's direction when the action says it: walking away (back to the camera), looking back
 * over the shoulder, or glancing past someone. '' when the action says nothing about it. Pure.
 */
export function facingSentence(person, towardLabel = 'the viewer', lookedAt = null) {
    const text = `${person?.action || ''} ${person?.expression || ''}`;
    const { He, looks } = pronouns(person?.cast);
    const his = { He: 'his', She: 'her', They: 'their' }[He];
    const is = He === 'They' ? 'are' : 'is';
    // A glance back at something that is not a person in the scene: the body turns from it.
    if (lookedAt && LOOKS_BACK.test(text)) return `${He} ${is} turned away from ${lookedAt}, and ${looks} back over ${his} shoulder at ${lookedAt}.`;
    if (lookedAt && LOOKS_PAST.test(text)) return `${His(He)} eyes are turned toward ${lookedAt}, away from the viewer.`;
    const viewer = towardLabel === 'the viewer';
    if (LOOKS_BACK.test(text)) return `${He} ${is} turned away from ${towardLabel}, and ${looks} back over ${his} shoulder at ${towardLabel}.`;
    if (WALKS_AWAY.test(text)) return viewer
        ? `${He} ${He === 'They' ? 'are' : 'is'} seen from behind, walking away from the viewer, back turned.`
        : `${He} ${He === 'They' ? 'walk' : 'walks'} away from ${towardLabel}, ${his} back turned to ${towardLabel} and to the viewer.`;
    if (LOOKS_DOWN.test(text)) return LOOKS_UP.test(text)
        ? `${His(He)} head is lowered toward ${towardLabel}, ${his} eyes looking up through ${his} lashes.`
        : `${His(He)} head is lowered, ${his} eyes cast down.`;
    if (LOOKS_PAST.test(text)) return `${He} ${He === 'They' ? 'face' : 'faces'} ${towardLabel}, ${his} eyes turned off to one side.`;
    return '';
}

function sameAs(text, name) {
    return Boolean(name) && new RegExp(`(?<![\\p{L}])${escapeRegex(String(name).trim())}(?![\\p{L}])`, 'iu').test(String(text || ''));
}

// ---------------------------------------------------------------- the frame

/**
 * The people of one frame, each joined with their cast entry and label. The player is dropped from
 * a POV frame (the viewer is the player). Pure.
 */
export function frameFigures(spec, cast, { personaName = '', pov = false } = {}) {
    const people = Array.isArray(spec?.people) ? spec.people : [];
    const names = people.length ? people : (spec?.characters || []).map((name) => ({ name }));
    const figures = names
        .filter((p) => p?.name && !(pov && personaName && norm(p.name) === norm(personaName)))
        .map((p) => {
            // Someone the cast book does not know yet: never their name as a label ("the alani").
            const known = findPerson(cast, p.name) || { name: p.name, label: 'the other person', sex: 'other', look: '', outfit: '' };
            // Before a change of clothes in the middle of the reply the person wears the OLD outfit, and what the
            // change took off is not yet off (the outfit of the whole reply was the last one in 1.07).
            const before = String(p.outfit_override || '').trim();
            const entry = before ? { ...known, outfit: before, takenOff: [] } : known;
            return { ...p, cast: entry, label: entry.label };
        });
    // The director sometimes lists one person twice ("Mira" and "Mira Hayashi"): two entries for
    // one person made the prompt say "two main figures: the student and the student" and drew her
    // twice. One person is one figure; the later entry only fills what the first one lacks.
    const out = [];
    for (const f of figures) {
        const same = out.find((o) => o.cast === f.cast || norm(o.label) === norm(f.label));
        if (!same) { out.push(f); continue; }
        for (const key of ['side', 'action', 'expression', 'gaze']) if (!String(same[key] || '').trim() && String(f[key] || '').trim()) same[key] = f[key];
    }
    // Two people are on the left and on the right: "in the middle" beside someone on the right, or
    // both on one side, left their places to chance.
    if (out.length === 2 && (out[0].side === out[1].side || out.some((f) => !['left', 'right'].includes(f.side)))) {
        const fixed = out.find((f) => f.side === 'left' || f.side === 'right');
        const other = fixed === out[0] ? out[1] : out[0];
        if (fixed && fixed.side !== other.side) other.side = fixed.side === 'left' ? 'right' : 'left';
        else { out[0].side = 'left'; out[1].side = 'right'; }
    }
    return out;
}

// Words that put two people side by side or in contact (then "facing each other" would be wrong).
// The story puts something between people on purpose.
// Only a thing the story puts BETWEEN them: "through the window", "behind bars", "a video call". A
// window or a table somewhere in the place is not one - "the window table" and "across the table"
// used to switch the shared-space sentence off, and the picture put a wall between the two talkers.
const BARRIER_OK = /\b(?:through|behind|beyond)\s+(?:a|an|the|his|her|their)?\s*(?:[\w-]+\s+){0,2}?(?:window|windows|glass|pane|windshield|door|gate|bars|grille|fence|screen|curtain|mirror|partition|barrier|railing|cell)\b|\bon the other side of (?:a|an|the)?\s*(?:[\w-]+\s+){0,2}?(?:window|glass|door|gate|bars|fence|wall|screen)\b|\b(?:cell door|prison cell|behind bars|video call|phone call|on (?:the )?(?:phone|screen)|via (?:a )?(?:screen|video)|separated by)\b/i;
/** The words the barrier test reads: what happens, never the place's name ("the window table"). */
const betweenText = (spec) => [spec?.description, spec?.interaction, ...(spec?.people || []).map((p) => p?.action)].join(' ');
// Going through a door is crossing it, not talking through it ("steps out through the train doors").
const CROSSING = /\b(?:step\w*|walk\w*|com(?:e|es|ing)|go(?:es|ing)?|pass\w*|run\w*|burst\w*|push\w*|slip\w*|hurr\w*|rush\w*|strid\w*|march\w*|climb\w*|squeez\w*|duck\w*|enter\w*|exit\w*|out|in|back)\s+(?:\w+\s+)?$/i;

/** True when the story puts something between the people of a frame. Pure. */
function barrierBetween(spec) {
    const text = betweenText(spec);
    const re = new RegExp(BARRIER_OK.source, 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) {
        if (/^(?:through|behind|beyond)\b/i.test(m[0]) && /\b(?:door|doors|doorway|gate)\b/i.test(m[0]) && CROSSING.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
        return true;
    }
    return false;
}
const CLOSE_TOGETHER = /\b(beside|next to|side by side|shoulder to shoulder|together|arm in arm|hug\w*|embrac\w*|hold\w* hands|lean\w* (?:on|against) (?:him|her|them)|touch\w*|grab\w*|hand\w* (?:over|him|her|them)|kiss\w*|whisper\w* (?:in|into) (?:his|her|their) ear)\b/i;

// Said positively on purpose: the model runs at CFG 1, where a negative prompt does nothing and a
// "never X" in the positive prompt puts X INTO the picture (A/B test 2026-09-30: "never a blank or
// white background" gave 27-30% white pixels, the positive wording 1-4%).
const NO_TEXT = 'Signs, pages and screens in the picture show only small pictures and unreadable marks.';

// Bodies on the move: two people walking together are side by side, never "facing each other".
const MOVING = /\b(?:walk\w*|strid\w*|jog\w*|run|runs|running|march\w*|stroll\w*|hurr\w*|pac(?:e|es|ing)\b|follow\w*|lead(?:s|ing)? the way|climb\w*|stepp?\w* (?:out|through|into|onto|off|forward|across)|heads? (?:to|toward|towards|for|down|up|off)|heading)\b/i;

/**
 * Everything a frame's words are built from, shared by the prompt and the quality check so both
 * read the same text: who is drawn, how names become labels, and the cleaning every sentence gets
 * (speech removed, absences removed, pronouns of people who are not drawn resolved). Pure.
 */
export function frameContext(spec, camera, ctx) {
    const kind = ['character', 'establishing', 'insert'].includes(spec?.kind) ? spec.kind : 'character';
    const cam = effectiveCamera(spec, kind === 'establishing' ? { ...camera, shot: 'wide shot' } : camera);
    // In first-person mode the player is never drawn, whatever angle the director chose (1.12: the director may now
    // use any angle in that mode, so the angle name "pov" is no longer the only sign of a first-person frame).
    const pov = cam.angle === 'pov' || Boolean(ctx.povMode);
    const figures = frameFigures(spec, ctx.cast, { personaName: ctx.personaName, pov });
    // People the background names are in the picture too (a known person further away, or one at
    // the edge when the frame already has three main figures): their labels stay in the text.
    const inBackground = backgroundPeopleOf(spec, ctx.cast, figures);
    const farAway = farAwayOf(spec, ctx.cast, figures);
    // Somebody who is not in this picture stays nobody in particular, and the player of a first-person
    // frame is the viewer: a label in the text made the model add a second man to a one-person picture.
    const pairs = framePairs(namePairs(ctx.cast, ctx.setBook), ctx.cast, figures, { personaName: ctx.personaName, farAway: inBackground });
    const swap = (t) => replaceNames(t, pairs);
    const persona = figures.find((f) => ctx.personaName && norm(f.name) === norm(ctx.personaName));
    const player = ctx.personaName ? findPerson(ctx.cast, ctx.personaName) : null;
    // Pronouns of a sex nobody drawn has ("glaring at him" in a picture of one girl) point at the
    // player when he is not drawn (the viewer), else at someone outside the picture.
    // Only the main figures count: "glaring at him" with a man far in the background is still the viewer.
    const drawn = kind === 'establishing' ? new Set(['other']) : new Set(figures.map((f) => f.cast?.sex || 'other'));
    // A sentence that names someone else of the cast says whom its pronoun means ("Alice sees Bob in the distance and
    // smiles at him"): the player is the one person a pronoun may point at without a name.
    const known = (ctx.cast || []).filter((c) => c && c !== player).map((c) => ({ names: [c.name, ...(c.aliases || []), c.label], sex: c.sex }));
    const who = { drawn, viewerSex: !persona && player ? player.sex : null, known };
    const clean = (t) => withoutStrayPronouns(withoutAbsences(stripSpeechSafe(swap(t), pairs)), who);
    // The player's own hands in a first-person insert (his phone in his palm).
    const ownHands = kind === 'insert' && pov && Boolean(player) && (spec?.people || []).some((p) => findPerson(ctx.cast, p?.name) === player || norm(p?.name) === norm(ctx.personaName));
    return { kind, cam, pov, figures, inBackground, farAway, pairs, swap, clean, persona, player, ownHands };
}

/** Whether two figures of a frame talk or look at each other (the pair a wall must not separate). Pure. */
function talkingPair(a, b, spec, ctx) {
    const together = (x, y) => refersTo(x.gaze || '', y, ctx.cast) || (VIEWER_WORD.test(x.gaze || '') && ctx.personaName && norm(y.name) === norm(ctx.personaName));
    return together(a, b) || together(b, a) || Boolean(String(spec?.interaction || '').trim());
}

/**
 * The prompt chunks for one frame.
 * @param {object} spec The planned frame (a parser beat).
 * @param {object} camera { shot, angle, forCrop? }
 * @param {object} ctx { style, presets, cast, setBook, world, setting, atmosphere, personaName }
 * @returns {string[]} natural style: one chunk; tag styles: shared chunk + one per person
 */
export function compileFrame(spec, camera, ctx) {
    const style = ctx.style || PROMPT_STYLES.NATURAL;
    const preset = ctx.presets?.[style] || {};
    const { kind, cam, pov, figures, farAway, swap, clean, persona, player, ownHands } = frameContext(spec, camera, ctx);
    const others = figures.filter((f) => f !== persona);
    const overShoulder = cam.angle === 'over the shoulder' && persona && others.length;
    // Two people who talk share one open space: nothing the setting lists as a divider is named then.
    const pairTalks = kind !== 'insert' && figures.length === 2 && !overShoulder && talkingPair(figures[0], figures[1], spec, ctx) && !barrierBetween(spec);
    const faceToFace = pairTalks || (overShoulder && others.length === 1);
    // What must not stand between two people facing each other: dividers, and glass (a window named in
    // the scenery was drawn as a pane between them). A redraw after a "wall between them" failure
    // (spec.clearSpace) leaves them out of any frame.
    const open = (t) => (faceToFace || spec?.clearSpace ? withoutGlass(withoutDividers(t)) : t);
    const where = String(spec?.location || ctx.setting || '').trim().replace(/\.$/, '');
    const place = matchPlace(where, ctx.setBook || []);
    const heldText = figures.map((f) => f.action || '').join(' ');
    const placeLook = withoutHeldProps(bare(place?.look), heldText);
    const placeText = place ? [place.label && !/^the (place|object)$/i.test(place.label) ? place.label : '', open(placeLook)].filter(Boolean).join(': ') : open(clean(where));
    // A spot inside a larger setting (a booth in a tavern) keeps the setting around it: alone it
    // was drawn floating on a white background.
    const around = ctx.setting && place && !where.toLowerCase().includes(String(ctx.setting).toLowerCase()) ? open(swap(bare(ctx.setting))) : '';
    const atmosphere = ctx.atmosphere || '';
    const frameText = [spec?.description, ...(spec?.people || []).map((p) => p?.action)].join(' ');
    const objects = objectsIn(frameText, ctx.setBook || []).map((o) => `${capitalize(o.label && !/^the (place|object)$/i.test(o.label) ? o.label : 'A recurring object')}: ${bare(o.look)}.`);
    const backgroundRaw = clean(spec?.background || '');
    const background = open(backgroundRaw);
    // In a first-person frame the player is the camera: a sentence about the player's own body ("The
    // viewer sits opposite her, forearms on the table") would draw a man there. The camera says it.
    // In a first-person insert of the player's own hands, only what the hands do stays.
    const HANDS_WORK = /\b(?:hands?|fingers?|palms?|thumbs?|wrists?|grip\w*|hold\w*|clutch\w*|grab\w*|rais\w*|wav\w*|tap\w*|typ\w*|scroll\w*|pour\w*|offer\w*|reach\w*|pick\w*|tak(?:e|es|ing)|sets?|plac\w*|puts?|toss\w*)\b/i;
    const ownBody = (t) => (pov && !persona ? String(t).split(/(?<=[.!?])\s+/).filter((x) => !/^the viewer(?:'s)?\b/i.test(x.trim()) || (ownHands && HANDS_WORK.test(x))).join(' ') : t);
    const description = ownBody(clean(spec?.description || ''));

    if (style !== PROMPT_STYLES.NATURAL) return compileTags({ spec, cam, kind, figures, preset, placeText, background, description: [description, clean(spec?.interaction || '')].filter(Boolean).join(', '), persona, view: kind === 'insert' ? '' : clean(spec?.view || ''), light: clean(spec?.light || '').replace(/\.$/, '') });

    const s = [];
    if (kind === 'insert') {
        // The player's own hands in a first-person insert (his phone, his palm): seen as he sees them.
        // Dropped as "the viewer", they used to leave "an object on its own ... in his palm".
        // Someone else's hands, drawn "hands and forearms only", came out as the viewer's own hands
        // reaching in from the bottom edge. Framed against their own clothes, they stay theirs.
        const holder = figures.length === 1 && !(ctx.personaName && norm(figures[0].name) === norm(ctx.personaName)) ? figures[0] : null;
        const his = holder ? pronouns(holder.cast).his : 'their';
        const top = holder ? framedOutfit(bare(holder.cast.outfit), 'close-up').split(',').map((t) => t.trim()).find((t) => /\b(shirt|t-shirt|top|blouse|jacket|coat|hoodie|sweater|dress|tunic|vest|robe|armou?r|breastplate|uniform|apron|cardigan|kimono)\b/i.test(t)) : '';
        const contactInsert = Boolean(holder && String(spec?.interaction || '').trim());
        const surface = holder ? ((`${spec?.description || ''} ${spec?.location || ''} ${placeText || ''} ${(spec?.people || []).map((x) => x?.action).join(' ')}`.match(/\b(table|counter|desk|bar|bench)\b/i) || [])[1] || '').toLowerCase().replace(/^bar$/, 'bar counter') : '';
        s.push(ownHands && !figures.length
            ? 'A first-person close-up: the viewer\'s own hands, coming in from the bottom edge of the picture, seen as the viewer sees them.'
            : !figures.length
                ? 'A close-up detail shot of an object on its own.'
                : contactInsert
                    ? `A close-up detail shot of ${holder.label}'s hands at the point of contact, seen from a side three-quarter angle: the handled object remains visible between the fingers and touches the other object named below.${top ? ` ${capitalize(top)} is visible at the edge of the frame.` : ''} The face is outside this close crop.`
                    : holder && surface
                        // Hands on a table, drawn "from the front", came out as a hand-over to the viewer
                        // with the VIEWER's hands (live test 2026-09-30, 6 of 6). Seen from the side across
                        // the table, with the forearms on it, they stay the holder's own. What the hands do
                        // is the description's (they stir, hold, tap - not always "wrapped around").
                        ? `A close-up detail shot of ${holder.label}'s hands on the ${surface}, seen from the side across the ${surface}, ${his} forearms resting on its edge. Only ${his} own hands and forearms are in the picture.`
                        : holder
                            ? `A close-up detail shot of ${holder.label}'s hands and an object, seen from the front: the hands are held in front of ${his} body${top ? `, against ${his} ${top.replace(/^(?:an?|the)\s+/i, '').replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase())}` : ''}, and the face is cut off above the top edge of the picture. Only ${holder.label}'s own two hands are in the picture.`
                            : `A close-up detail shot of hands and an object. Only the hands and forearms of ${figures.map((f) => f.label).join(' and ')} fill the picture.`);
        // Someone's hands meet the player's in a first-person insert (a hand-over): the viewer's own hand.
        if (ownHands && figures.length) s.push('The viewer\'s own hand reaches in from the bottom edge of the picture to meet them, seen first-person.');
        if (ownHands && !figures.length) {
            const skin = ((bare(player.look).match(/[^,]*\bskin\b[^,]*/i) || [''])[0]).replace(/\s+(?:with|and)\b.*$/i, '').trim();
            const items = framedOutfit(bare(player.outfit), 'full shot').split(',').map((t) => t.trim());
            // What shows at the wrists: gloves or a watch, long sleeves, else bare forearms (a T-shirt).
            const onHands = items.find((t) => /\b(gloves?|gauntlets?|bracers?|watch|bracelets?|rings?)\b/i.test(t));
            const longSleeve = items.find((t) => /\b(jacket|coat|hoodie|sweater|cardigan|long-sleeved|sweatshirt|robe|armou?r)\b/i.test(t));
            const wrists = onHands ? `, ${onHands}` : longSleeve ? `, the sleeves of the ${longSleeve.replace(/^(?:an?|the)\s+/i, '').replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase())} at the wrists` : ', bare forearms';
            s.push(`The viewer's hands (${[nounOf(player).replace(/^an? /, ''), skin].filter(Boolean).join('; ')})${wrists}.`);
        }
    } else if (pov) {
        s.push('A first-person view: the camera is the viewer\'s own eyes, looking out at the scene.');
        s.push(cameraPhrase({ shot: cam.shot }));
    } else if (overShoulder) {
        // "who faces the viewer" only when the action does not turn them away (walking off, looking back).
        const turnedAway = others.some((o) => facingSentence(o, 'the viewer', null));
        s.push(`Over-the-shoulder shot from behind ${persona.label}: the back of the head and one shoulder fill the near foreground, and we look past at ${others.map((f) => f.label).join(' and ')}${turnedAway ? '' : `, who ${others.length > 1 ? 'face' : pronouns(others[0].cast).faces} the viewer`}.`);
    } else if (kind === 'establishing') {
        s.push(figures.length || background
            ? 'A wide establishing shot: the place itself is the subject, and the people in it are small.'
            : 'A wide establishing shot of the empty place itself: the scenery fills the whole picture.');
    } else {
        // "Over the shoulder" with nobody's shoulder in the frame is an eye-level view (a stranger's
        // shoulder was drawn otherwise).
        s.push(cameraPhrase(cam.angle === 'over the shoulder' ? { ...cam, angle: 'eye level' } : cam));
    }

    if (kind !== 'insert' && figures.length) {
        const count = figures.length;
        s.push(count === 1 ? `One main figure: ${figures[0].label}.` : `${['', '', 'Two', 'Three', 'Four'][count] || count} main figures: ${figures.map((f) => f.label).join(count === 2 ? ' and ' : ', ')}.`);
        // Posture said on its own, right after who is in the picture: at the end of a long action
        // ("Still seated, leaning forward with hands in her pockets") it lost to the action and the
        // girl was drawn standing (A/B 2026-10-01: standing 4 of 4; with this sentence, sitting 4 of 4).
        for (const f of figures) {
            if (overShoulder && f === persona) continue;
            const posture = postureOf(`${f.action || ''}`);
            if (!posture) continue;
            const text = `${f.action || ''} ${spec?.description || ''} ${spec?.location || ''}`;
            // Where she sits: the action first, then what the description says about HER, then the place ("Alice sits
            // on the floor" in the description gave "on a chair" next to "on the floor" in 1.07).
            const SEAT = /\b(chair|stool|bench|sofa|couch|bed|floor|ground|steps|stairs|bar stool|booth|seat|armchair|cushion|rug|log|rock|crate|barrel|ledge|curb|windowsill)\b/i;
            const mine = sentencesOf(String(spec?.description || '')).filter((x) => new RegExp(`(?<![\\p{L}])${String(f.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').test(x) || (f.label && x.toLowerCase().includes(String(f.label).toLowerCase()))).join(' ');
            const seat = ((String(f.action || '').match(SEAT) || mine.match(SEAT) || String(spec?.location || '').match(SEAT) || [])[1]);
            const furniture = (text.match(/\b(table|counter|desk|bar|booth)\b/i) || [])[1];
            // A chair is implied only by a table, desk or counter the person sits at; with nothing said, no furniture is made up.
            const place = seat ? ` on the ${seat.toLowerCase()}` : (furniture && !/^booth$|^bar$/i.test(furniture) ? ' on a chair' : '');
            if (posture === 'seated') s.push(`${capitalize(f.label)} is sitting${place}${furniture && !/booth|bar/i.test(seat || '') ? ` at the ${furniture.toLowerCase()}` : ''}.`);
            else s.push(`${capitalize(f.label)} is ${posture === 'kneeling' ? 'kneeling' : 'lying down'}.`);
        }
        if (count > 1 && !overShoulder) {
            const rank = { left: 0, center: 1, right: 2 };
            const ordered = [...figures].sort((a, b) => (rank[a.side] ?? 1) - (rank[b.side] ?? 1));
            s.push(`From left to right: ${ordered.map((f) => f.label).join(', ')}.`);
        }
        // Onlookers were drawn lined up facing the viewer like a group photo: people who watch
        // someone in the frame are turned toward them.
        if (count > 1 && !overShoulder) {
            for (const target of figures) {
                const watchers = figures.filter((f) => f !== target && String(f.gaze || '').trim() && (sameAs(f.gaze, target.name) || (target.cast?.aliases || []).some((a) => sameAs(f.gaze, a))));
                if (watchers.length >= 2 || (watchers.length === 1 && count >= 3)) {
                    s.push(`${capitalize(watchers.map((f) => f.label).join(' and '))} ${watchers.length > 1 ? 'are' : 'is'} turned toward ${target.label}, watching.`);
                }
            }
        }
        // Two people who look at each other were drawn shoulder to shoulder like a photo pair; two who
        // walk together are side by side (never "facing each other" - they would walk into each other).
        let faceEach = false;
        if (count === 2 && !overShoulder && !String(spec?.interaction || '').trim()) {
            const [a, b] = figures;
            const looksAt = (x, y) => sameAs(x.gaze || '', y.name) || (y.cast?.aliases || []).some((al) => sameAs(x.gaze || '', al))
                || (VIEWER_WORD.test(x.gaze || '') && ctx.personaName && norm(y.name) === norm(ctx.personaName));
            const close = CLOSE_TOGETHER.test([spec?.description, a.action, b.action].join(' '));
            const turning = [a, b].some((f) => LOOKS_BACK.test(`${f.action || ''}`) || WALKS_AWAY.test(`${f.action || ''}`));
            const moving = [a, b].filter((f) => MOVING.test(`${f.action || ''}`)).length;
            // Two people seated at one table are an arm's length apart across it, not "a few steps".
            const seated = [a, b].every((f) => postureOf(`${f.action || ''}`) === 'seated');
            const furniture = (`${spec?.description || ''} ${a.action || ''} ${b.action || ''} ${spec?.location || ''}`.match(/\b(table|counter|desk|bar|booth)\b/i) || [])[1];
            // Something the story puts between them (through a window, behind bars): no open-space sentence.
            if (looksAt(a, b) && looksAt(b, a) && !turning && !barrierBetween(spec)) {
                if (moving === 2) { faceEach = true; s.push(`${capitalize(a.label)} and ${b.label} walk side by side, turning their heads toward each other.`); }
                else if (seated) { faceEach = true; s.push(`${capitalize(a.label)} and ${b.label} sit facing each other${furniture ? ` across the same ${furniture.toLowerCase()}` : ''}, close together in one open space.`); }
                else if (!close) { faceEach = true; s.push(`${capitalize(a.label)} and ${b.label} face each other with a few steps of open space between them.`); }
            }
        }
        // Two people who talk or look at each other share one open space: a wall, pillar, door frame
        // or panel between them was drawn when nothing said otherwise. Not said when the story puts
        // something between them on purpose (through a window, behind bars, a video call).
        if (pairTalks && !faceEach) s.push(`${capitalize(figures[0].label)} and ${figures[1].label} are in one open space, in plain view of each other.`);
    }
    const contact = clean(spec?.interaction || '');
    if (contact) s.push(`The key moment, clearly visible: ${sentence(contact)}`);
    if (kind !== 'insert') s.push(background ? `${figures.length ? 'Around them' : 'In the scene'}: ${background.replace(/\.$/, '')}.` : '');
    if (description) s.push(sentence(description));
    s.push(placeText ? `Setting: ${[placeText, around ? (/^(in|inside|within|at|on|outside|under|beneath|atop|near|by)\b/i.test(around) ? around.charAt(0).toLowerCase() + around.slice(1) : `inside ${around.replace(/^(A|An|The)\b/, (a) => a.toLowerCase())}`) : '', atmosphere].filter(Boolean).join(', ')}.` : '');
    // 1.13: the part of the place this frame looks at (the whole-place text above is the same in every frame, and every frame
    // was the same corridor: Gemini review of a 5-frame scroll, 2026-10-02).
    const view = kind === 'insert' ? '' : clean(spec?.view || '');
    if (view) s.push(`In this view, the background shows ${view.replace(/^(?:the\s+)?background\s+(?:shows\s+)?/i, '').replace(/\.$/, '')}.`);
    // 1.15: the light of this frame. Every night scene came out evenly bright (Gemini review: "evenly and brightly lit,
    // betraying the blackout") because "vibrant full color" closed every prompt; a dark frame drops it and says what is dark.
    const light = clean(spec?.light || '').replace(/\.$/, '');
    const dark = isDarkLight(light);
    if (light) s.push(dark ? `Lighting: ${light}. The picture is low-key and dim, with deep shadows and only a few pools of light, not evenly lit.` : `Lighting: ${light}.`);
    // 1.15: one person off-centre. A same-seed test: "placed in the left third, open space on the right" moves the figure and the camera.
    if (kind === 'character' && figures.length === 1 && !cam.forCrop && !/close-up/.test(cam.shot || '') && (figures[0].side === 'left' || figures[0].side === 'right')) {
        const side = figures[0].side;
        s.push(`Composition: ${figures[0].label} is placed in the ${side} third of the frame, with open space on the ${side === 'left' ? 'right' : 'left'}.`);
    }
    if (kind !== 'insert') s.push('The background is the setting itself, fully drawn and painted edge to edge.');
    // A "manhwa" prompt sometimes came back as two stacked panels of the same moment.
    s.push('It is one single continuous picture.');
    s.push(...objects);
    if (ctx.world?.era_and_technology) s.push(eraPhrase(ctx.world.era_and_technology));

    // Someone who watches a person far away in the background is seen from behind, looking into the
    // picture - never the only main figure (that turned the frame's subject away from the reader).
    const watchingFar = figures.length > 1 ? figures.filter((f) => farAway.some((c) => sameAs(f.gaze || '', c.name))) : [];
    if (watchingFar.length && kind !== 'insert' && !pov) s.push(`${capitalize(watchingFar.map((f) => f.label).join(' and '))} ${watchingFar.length > 1 ? 'are' : 'is'} seen from behind at a three-quarter angle, facing into the picture toward ${farAway.find((c) => watchingFar.some((f) => sameAs(f.gaze || '', c.name))).label} in the distance.`);
    const anchored = kind !== 'insert' && !overShoulder && figures.length > 1 && new Set(figures.map((f) => f.side)).size === figures.length;
    for (const f of figures) {
        const p = f.cast;
        const outfit = framedOutfit(bare(p.outfit), cam.shot);
        if (kind === 'insert') {
            // What is on the hands and arms (gauntlets, gloves, rings, sleeves, a scrunchie), else
            // the first garment - the one thing that tells whose hands these are.
            const parts = framedOutfit(bare(p.outfit), 'full shot').split(/,|\band\b/).map((t) => t.trim()).filter(Boolean);
            const onHands = parts.filter((t) => /\b(gauntlets?|gloves?|bracers?|vambraces?|rings?|sleeves?|cuffs?|mitts?|bracelets?|bangles?|wraps?|scrunchies?|wristbands?|watch|wristwatch|hair ties?|nail polish|manicure)\b/i.test(t));
            const sleeve = onHands.length ? `, wearing ${onHands.join(', ')}` : (parts[0] ? `, wearing ${parts[0]}` : '');
            // Skin without face words ("light skin with prominent blush"); age and build keep the hands
            // the person's own (a boy's catch was drawn with a grown man's hairy hand).
            const skin = ((bare(p.look).match(/[^,]*\bskin\b[^,]*/i) || [''])[0]).replace(/\s+(?:with|and)\b.*$/i, '').trim();
            const body = bare(p.look).split(',').map((t) => t.trim()).filter((t) => /\b(\d{1,2}(?:\s*|-)years?(?:\s*|-)old|build|frame|petite|slender|muscular|stocky|burly|elderly|aged)\b/i.test(t) && !NUMBER_TRAIT.test(t.replace(/\d{1,2}(?:\s*|-)years?(?:\s*|-)old/i, '')));
            const whose = [nounOf(p).replace(/^an? /, ''), ...body].join(', ');
            s.push(`${capitalize(f.label)}'s hands (${[whose, skin].filter(Boolean).join('; ')})${sleeve}.`);
            continue;
        }
        const fromBehind = overShoulder && f === persona;
        const rear = !fromBehind && cam.angle === 'from behind';
        const look = plainLook(bare(p.look));
        const body = [look, outfit ? `wearing ${outfit}` : ''].filter(Boolean).join('; ');
        // The player seen from behind keeps his posture: "sits upright, seen from behind" became a man
        // standing in a café where everyone sits (live test 2026-09-30).
        const posture = fromBehind ? postureOf(f.action || '') : null;
        const action = fromBehind ? `Seen from behind${posture ? `, ${posture === 'lying' ? 'lying down' : posture}` : ''}, the back of the head toward the viewer` : rear ? `Seen from behind, the back of the head toward the viewer. ${clean(f.action || '')}` : clean(f.action || '');
        const face = fromBehind || rear ? '' : clean(f.expression || '');
        const eyes = fromBehind || rear ? '' : gazeSentence(f, figures, { personaName: ctx.personaName, pov, overShoulder: Boolean(overShoulder), swap, farAway, cast: ctx.cast });
        // With two or three people in the picture, each description starts from where the person stands:
        // outfits leaked across people otherwise (live test 2026-09-30: the vendor's apron was drawn on
        // the other woman in 3 of 4 images; with "On the left ... On the right ..." in 0 of 4).
        const anchor = anchored ? { left: 'On the left, ', right: 'On the right, ', center: 'In the middle, ' }[f.side] || '' : '';
        s.push([`${anchor ? anchor + f.label : capitalize(f.label)} is ${nounOf(p)}${body ? `: ${body}` : ''}.`, sentence(action), sentence(face), eyes].filter(Boolean).join(' '));
    }
    s.push(NO_TEXT);

    const framing = kind === 'establishing' ? 'scenery, wide shot' : kind === 'insert' ? 'close-up, hands focus' : (NATURAL_FRAMING[cam.shot] || '');
    const prefix = withFramingTags(preset.prefix, framing);
    const suffix = dark ? withoutVibrantColor(preset.suffix) : String(preset.suffix || '').trim();
    return [[prefix, tidy(s.filter(Boolean).join(' ')), suffix].filter(Boolean).join(' ')];
}

/**
 * The era, for the image prompt: the first clause only. The world book's "Contemporary modern day;
 * smartphones, commuter trains, electric appliances, stainless steel espresso machines, transit cards"
 * drew ticket machines and espresso machines behind a flower stall (2026-09-30): every object named in
 * a prompt is drawn somewhere. Clauses that say what the world lacks ("no gunpowder") go too. Pure.
 */
export function eraPhrase(text) {
    const first = String(text || '').split(/[;.]/)[0]
        .split(/,\s*/).filter((c) => !/^\s*(?:no|without|never|lacking)\b/i.test(c)).slice(0, 2).join(', ')
        .replace(/\s+/g, ' ').trim();
    return first ? `World: ${first}.` : '';
}

/** Words that make a frame's light dark (night, a blackout, candle or flashlight light, a cellar, a storm). Pure. */
const DARK_LIGHT = /\b(?:dark(?:ness|ened)?|dim(?:ly|med)?|night(?:time)?|moon(?:lit|light)?|candle(?:light|lit)?|torch(?:light|lit)?|fire(?:light|lit)|lantern(?:light|lit)?|lamp(?:light|lit)|gloom\w*|shadow\w*|dusk|twilight|blackout|pitch[- ]black|underground|cellar|dungeon|crypt|storm\w*|flashlight|low[- ]key)\b/i;
export function isDarkLight(light) { return DARK_LIGHT.test(String(light || '')); }

/** The style suffix without "vibrant (full) colo(u)r(s)", which flattens every night scene into daylight. Pure. */
export function withoutVibrantColor(suffix) {
    return String(suffix || '').replace(/[,;]?\s*\bvibrant(?:\s+full)?(?:[\s-]+)?colou?rs?\b/gi, '').replace(/\s+,/g, ',').replace(/,\s*\./g, '.').replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/(?<![.!?])$/, (m, o, str) => (/\.$/.test(String(suffix || '').trim()) && str ? '.' : '')).trim();
}

/** Tag-style models (Illustrious / Pony): a shared chunk plus one chunk per person. */
function compileTags({ spec, cam, kind, figures, preset, placeText, background, description, persona, view = '', light = '' }) {
    const dark = isDarkLight(light);
    const count = (sex) => figures.filter((f) => f.cast.sex === sex).length;
    const n = (k, word) => (k ? (k === 1 ? `1${word}` : `${k}${word}s`) : '');
    const counts = kind === 'insert' ? [] : [n(count('female'), 'girl'), n(count('male'), 'boy'), n(count('other'), 'other')].filter(Boolean);
    if (kind !== 'insert' && figures.length === 1 && !background) counts.push('solo');
    if (figures.length >= 3) counts.push('multiple people');
    if (kind === 'establishing') counts.push('scenery', figures.length ? '' : 'no humans');
    if (kind === 'insert') counts.push('close-up', 'hands focus');
    const shared = [
        String(preset.prefix || '').trim(),
        ...counts,
        cameraTags(cam),
        description,
        background ? `background: ${background}` : '',
        placeText,
        view,
        light ? (dark ? `${light}, dark, dim lighting, low key, deep shadows` : light) : '',
        'no text',
        dark ? withoutVibrantColor(preset.suffix) : String(preset.suffix || '').trim(),
    ].filter(Boolean).join(', ');
    const persons = kind === 'insert' ? [] : figures.map((f) => {
        const p = f.cast;
        const tag = p.sex === 'female' ? '1girl' : p.sex === 'male' ? '1boy' : '1other';
        const adult = isYoung(p) ? '' : 'adult';
        const back = cam.angle === 'from behind';
        return [tag, adult, withoutRearTraits(p.look), framedOutfit(p.outfit, cam.shot), (f === persona && cam.angle === 'over the shoulder') || back ? 'from behind' : f.action, back ? '' : f.expression]
            .filter(Boolean).join(', ');
    });
    return [shared, ...persons];
}

/**
 * What the quality check should find in the finished picture: the main figures with their look and
 * outfit, the key action, and the frame's kind. Pure.
 */
const WRITTEN_THING = /\b(newspapers?|headlines?|letters? (?:from|to)|the letter|a letter|notes?|posters?|notices?|signs?|signboards?|books?|pages?|scrolls?|maps?|menus?|documents?|contracts?|papers?|writing|written|inscriptions?|inscribed|runes?|glyphs?|script|symbols?|question marks?|status (?:window|screen|panel)|interface|screens?|display|reads? (?:the|a|it))\b/i;

export function frameExpectation(spec, camera, ctx) {
    const { kind, cam, pov, figures, swap, clean, persona, ownHands } = frameContext(spec, camera, ctx);
    const lines = [];
    if (ownHands) lines.push('Hands: this is a first-person view - hands reaching in from the bottom edge are the viewer\'s own. That is correct here, not a defect.');
    lines.push(`Frame kind: ${kind === 'insert' ? 'a close-up of hands and an object' : kind === 'establishing' ? 'a wide view of a place (people small or absent)' : `${cam.shot}${cam.forCrop ? ' (this picture will be cropped to a close-up of the first person, so their face must be clearly visible)' : ''}`}.`);
    if (figures.length) {
        lines.push(`Main figures (exactly ${figures.length}):`);
        for (const f of figures) {
            const outfit = framedOutfit(f.cast.outfit, cam.shot);
            const off = (f.cast.takenOff || []).length ? ` Has taken off (must NOT be wearing now): ${f.cast.takenOff.join(', ')}.` : '';
            const fromBehind = cam.angle === 'over the shoulder' && f === persona && figures.length > 1;
            lines.push(`- "${f.label}": ${[withoutAbsences(f.cast.look || ''), outfit ? `wearing ${outfit}` : ''].filter(Boolean).join('; ') || 'no stated look'}.${off} Doing: ${fromBehind ? 'seen from behind in the foreground' : (clean(f.action || '') || '-')}`);
        }
    } else {
        lines.push('Main figures: none.');
    }
    // What the picture must get right between the people: where each looks, and that two people who
    // talk stand in one open space. Gazes that the action overrides (walking away, glancing past) and
    // gazes at objects or places are not checked.
    const gazes = [];
    if (kind !== 'insert') {
        for (const f of figures) {
            if (!String(f.gaze || '').trim() || facingSentence(f, 'the viewer', 'x')) continue;
            if (cam.angle === 'over the shoulder' && f === persona) continue;
            const other = figures.find((g) => g !== f && refersTo(f.gaze, g, ctx.cast));
            const player = ctx.personaName && sameAs(f.gaze, ctx.personaName);
            if (other) gazes.push({ label: f.label, target: other.label });
            else if (!pov && !player && VIEWER_WORD.test(f.gaze) && !figures.some((g) => g !== f && ctx.personaName && norm(g.name) === norm(ctx.personaName))) gazes.push({ label: f.label, target: 'the viewer' });
        }
    }
    // The posture the story keeps (a standing girl in a café where everyone sits was passed as fine).
    for (const f of figures) {
        if (cam.angle === 'over the shoulder' && f === persona) continue;
        const posture = postureOf(`${f.action || ''}`);
        if (posture) lines.push(`Posture: "${f.label}" must be ${posture === 'seated' ? 'sitting (on a chair or seat), not standing' : posture === 'kneeling' ? 'kneeling' : 'lying down'} - part of "Doing".`);
    }
    for (const g of gazes) lines.push(`Gaze: "${g.label}" must be looking at ${g.target === 'the viewer' ? 'the camera' : `the face of "${g.target}"`} (not down at an object, not elsewhere).`);
    const together = kind !== 'insert' && figures.length === 2 && !barrierBetween(spec)
        && (gazes.some((g) => g.target !== 'the viewer') || Boolean(String(spec?.interaction || '').trim()));
    if (together) lines.push(`Space: "${figures[0].label}" and "${figures[1].label}" share one open space - no wall, pillar, door frame, window or divider may stand between them.`);
    if (spec?.background) lines.push(`Background people allowed: ${clean(spec.background)}`);
    if (spec?.description) lines.push(`What happens: ${clean(spec.description)}`);
    const contact = clean(spec?.interaction || '');
    if (contact) lines.push(`Key moment that must be clearly visible: ${contact}`);
    // An insert shows hands, not people: nobody is checked for presence there. A frame about
    // something written (a newspaper, a letter, a sign) will show letters; that is not a fault there.
    const writing = WRITTEN_THING.test(`${spec?.description || ''} ${spec?.people?.map((p) => p.action).join(' ') || ''}`);
    return { text: lines.join('\n'), gazes, together, labels: kind === 'insert' ? [] : figures.map((f) => f.label), kind, forCrop: Boolean(cam.forCrop), writing, contact: Boolean(contact), crowd: Boolean(String(spec?.background || '').trim()) };
}
