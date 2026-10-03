// Moment cards: what a picture must SAY, written down before anyone decides how to draw it.
//
// A frame used to be a bundle of fields (a description, a pose per person, a camera) and the picture was whatever those
// words happened to add up to. A moment card is the decision underneath them, in model-free words:
//   facts     the 2-4 things the picture must make visible - who does what, to or with whom/what, where, how
//   needs     what has to be IN VIEW for those facts to be readable (faces, hands, a whole body, both people, the place, an object)
//   holding   who holds or touches which object, in which hand (an object nobody holds is not in anyone's hand)
//   spots     where each person is IN THE PLACE ("at the kitchen island", "in the doorway"): not left/right of the picture
//   invented  details the artist chose that the text does not state (so they are never presented as story facts)
// The camera is then chosen by what shows the facts, not by a rule that always shows faces or always shows hands.
//
// The scene also carries a STATE at the end of the reply (objects and who has them, where people are, the light), which the
// next reply's reader receives, so a phone picked up in one reply is still in the hand - or on the table - in the next.
//
// Everything here is pure and knows no image model. How the card is turned into words for one model is the prompt
// builder's job (with that model's adapter).

export const NEEDS = ['faces', 'hands', 'whole body', 'both people', 'the place', 'an object'];
export const HANDS = ['left hand', 'right hand', 'both hands', 'other'];

const MAX_FACTS = 4;
const MAX_TEXT = 240;

const text = (v, max = MAX_TEXT) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The JSON-schema of one frame's card (strict mode: every property is required). */
export function momentSchema() {
    const named = (extra, description) => ({
        type: 'array',
        description,
        items: { type: 'object', properties: extra, required: Object.keys(extra), additionalProperties: false },
    });
    return {
        type: 'object',
        description: 'The MOMENT CARD of this frame (see MOMENT CARDS).',
        properties: {
            facts: { type: 'array', items: { type: 'string' }, description: 'The 2-4 facts this picture must make visible, most important first: one short concrete sentence each (who does what to or with whom or what, where, how). Only what the text states or clearly implies - never a new event.' },
            needs: { type: 'array', items: { type: 'string', enum: NEEDS }, description: 'What must be IN VIEW for those facts to be readable: faces (a look, an expression), hands (a gesture, a grip), whole body (a posture, a walk, a bend), both people (a contact or an exchange between them), the place, an object.' },
            holding: named({
                person: { type: 'string', description: 'Exactly as in "cast".' },
                object: { type: 'string', description: 'The object, as the text gives it (material, colour, count).' },
                hand: { type: 'string', enum: HANDS },
            }, 'Who holds or touches which object in THIS frame, in which hand. Only what the text gives or clearly implies, and it carries over from the frame before until the text puts it down. [] when nobody holds anything.'),
            spots: named({
                person: { type: 'string', description: 'Exactly as in "cast".' },
                spot: { type: 'string', description: 'Where they are IN THE PLACE, from the text ("at the kitchen island", "in the doorway", "by the window"). Not left or right of the picture.' },
            }, 'Where each main figure is in the place. [] when the text does not say.'),
            invented: { type: 'array', items: { type: 'string' }, description: 'Details YOU chose that the text does not state (a prop, a pose, a sign of the expression, a gaze). Short. [] when everything is from the text.' },
        },
        required: ['facts', 'needs', 'holding', 'spots', 'invented'],
        additionalProperties: false,
    };
}

/** The scene's state at the END of the reply. */
export function stateSchema() {
    return {
        type: 'object',
        description: 'The state of the scene at the END of this reply, for the next reply (see STATE).',
        properties: {
            objects: { type: 'array', description: 'Objects that matter and where each is now: held by a named person (which hand), or in a place.', items: { type: 'object', properties: { object: { type: 'string' }, where: { type: 'string' } }, required: ['object', 'where'], additionalProperties: false } },
            spots: { type: 'array', description: 'Where each person is in the place now.', items: { type: 'object', properties: { person: { type: 'string' }, spot: { type: 'string' } }, required: ['person', 'spot'], additionalProperties: false } },
            light: { type: 'string', description: 'The light now, in a short plain phrase ("" when unknown).' },
        },
        required: ['objects', 'spots', 'light'],
        additionalProperties: false,
    };
}

/** The part of the system prompt that explains cards and state. */
export const MOMENT_RULES = `

MOMENT CARDS (every frame has a "moment"; fill it BEFORE the other fields of the frame, then write the frame from it)
- "facts": the 2-4 things this picture must make visible, most important first. Each is ONE short concrete sentence in the text's own terms: who does what to or with whom or what, where, how. A moment is not a mood: "Nora reaches for the phone and Alex pulls it against his chest" is a fact, "tension" is not.
- "needs": what has to be in view for the facts to be readable. A gesture of the hands or a grip needs "hands"; a look or an expression needs "faces"; a walk, a bend, a seat or a stand needs "whole body"; a contact or exchange between two people needs "both people"; where something happens needs "the place"; a thing that matters needs "an object". The camera is chosen from this: if the facts need hands AND faces, the shot shows both (a medium shot), and if they need two different views, use TWO frames (the second with "same_moment" true) - within the frame budget.
- "holding": who holds or touches which object, in which hand, in THIS frame. Objects carry over from the frame before and from the STATE block until the text puts them down; an object nobody holds is lying somewhere, not in a hand.
- "spots": where each main figure is IN THE PLACE ("at the kitchen island", "in the doorway", "next to the car"), from the text. This is not the left/right of the picture ("side" does that).
- "invented": every detail you chose that the text does not give (a prop, a pose, a sign of the expression, a gaze). Choices are allowed; stating them as facts is not. Never invent an event, a line or a change to the story.
- Facts are stated things; "invented" are choices. Nothing in "facts" may be in "invented".

STATE (fill "state" last)
- At the END of the reply: the objects that matter and where each is now (held by whom, in which hand; or in which place), where each person is in the place, and the light. The next reply starts from it.`;

/** The state block of the user prompt (what the last reply ended with), or '' when there is none. */
export function formatKnownState(state) {
    if (!state) return '';
    const lines = [];
    for (const o of state.objects || []) if (text(o?.object) && text(o?.where)) lines.push(`- ${text(o.object, 80)}: ${text(o.where, 120)}`);
    for (const s of state.spots || []) if (text(s?.person) && text(s?.spot)) lines.push(`- ${text(s.person, 60)} is ${text(s.spot, 120)}`);
    if (text(state.light)) lines.push(`- light: ${text(state.light, 120)}`);
    return lines.join('\n');
}

/** A clean state object from whatever the reader returned, or null when it is empty. Pure. */
export function cleanState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const objects = (Array.isArray(raw.objects) ? raw.objects : []).map((o) => ({ object: text(o?.object, 80), where: text(o?.where, 120) })).filter((o) => o.object && o.where).slice(0, 12);
    const spots = (Array.isArray(raw.spots) ? raw.spots : []).map((s) => ({ person: text(s?.person, 60), spot: text(s?.spot, 120) })).filter((s) => s.person && s.spot).slice(0, 8);
    const light = text(raw.light, 120);
    return objects.length || spots.length || light ? { objects, spots, light } : null;
}

/** The state the last earlier reply that had one ended with. Pure. */
export function findKnownState(chat, messageId, lookback = 12) {
    for (let i = messageId - 1; i >= Math.max(0, messageId - lookback); i--) {
        const state = cleanState(chat?.[i]?.extra?.manga?.scene?.state);
        if (state) return state;
    }
    return null;
}

/**
 * A frame's card, cleaned: at most four facts, needs from the list, holdings and spots with a person and a thing, and no
 * invented detail inside the facts. null when the frame has no (usable) card - then the frame is drawn the classic way. Pure.
 */
export function readMoment(spec) {
    const raw = spec?.moment;
    if (!raw || typeof raw !== 'object') return null;
    const invented = (Array.isArray(raw.invented) ? raw.invented : []).map((x) => text(x, 120)).filter(Boolean);
    const lowered = invented.map((x) => x.toLowerCase());
    const facts = (Array.isArray(raw.facts) ? raw.facts : []).map((f) => text(f)).filter(Boolean)
        .filter((f) => !lowered.some((x) => x.length >= 8 && f.toLowerCase().includes(x)))
        .slice(0, MAX_FACTS);
    if (!facts.length) return null;
    const needs = [...new Set((Array.isArray(raw.needs) ? raw.needs : []).map((n) => text(n, 30).toLowerCase()).filter((n) => NEEDS.includes(n)))];
    const holding = (Array.isArray(raw.holding) ? raw.holding : []).map((h) => ({ person: text(h?.person, 60), object: text(h?.object, 80), hand: HANDS.includes(h?.hand) ? h.hand : 'other' })).filter((h) => h.person && h.object);
    const spots = (Array.isArray(raw.spots) ? raw.spots : []).map((s) => ({ person: text(s?.person, 60), spot: text(s?.spot, 120) })).filter((s) => s.person && s.spot);
    return { facts, needs, holding, spots, invented };
}

/** A copy of the scene whose frames carry no card: what the classic pipeline plans from. Pure. */
export function withoutMoments(scene) {
    if (!scene || !Array.isArray(scene.beats) || !scene.beats.some((b) => b && b.moment)) return scene;
    return { ...scene, beats: scene.beats.map((b) => { if (!b || !b.moment) return b; const { moment: _m, ...rest } = b; return rest; }) };
}

/**
 * The camera that shows the facts. A close-up cannot show hands, an object or two people, a close or medium shot cannot show a whole
 * body or the place around it. Inserts and establishing views were chosen on purpose and stay. Only ever WIDENS a shot (a face the
 * reader wanted close stays close when the facts need only the face). Pure.
 */
export function momentCamera(spec, camera) {
    const card = readMoment(spec);
    if (!card || !camera || spec?.kind === 'insert' || spec?.kind === 'establishing' || camera.forCrop) return camera;
    const needs = new Set(card.needs);
    const shot = camera.shot || 'medium shot';
    const tight = shot === 'close-up' || shot === 'extreme close-up';
    let target = null;
    if (needs.has('whole body') && (tight || shot === 'medium shot')) target = 'full shot';
    else if (needs.has('the place') && !needs.has('faces') && (tight || shot === 'medium shot')) target = 'full shot';
    else if ((needs.has('hands') || needs.has('an object') || needs.has('both people')) && tight) target = 'medium shot';
    return target ? { ...camera, shot: target, momentWidened: shot } : camera;
}

// ---------------------------------------------------------------- words for the prompt (model-free)

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'at', 'her', 'his', 'their', 'its', 'with', 'for', 'as', 'while', 'is', 'are', 'from', 'into', 'by', 'that', 'it', 'she', 'he', 'they', 'one', 'both']);
const stem = (w) => w.replace(/(ing|ed|es|s)$/i, '');

/** The content words of a text, lower-cased and stemmed. */
export function contentWords(value) {
    return String(value || '').toLowerCase().match(/[a-z][a-z'-]*/g)?.map((w) => stem(w.replace(/'s$/, ''))).filter((w) => w.length > 2 && !STOP.has(w)) || [];
}

/** How many of a text's content words are NOT in a base text. */
export function newWords(textValue, base) {
    const have = new Set(contentWords(base));
    return contentWords(textValue).filter((w) => !have.has(w)).length;
}

/** The share of a text's content words that a base text has. 1 = the base says all of it. */
export function covered(textValue, base) {
    const words = contentWords(textValue);
    if (!words.length) return 1;
    const have = new Set(contentWords(base));
    return words.filter((w) => have.has(w)).length / words.length;
}

/** "in her right hand" for a holding entry ("" for a hand the card does not name). */
export function handPhrase(hand, pronoun = 'their') {
    return { 'left hand': `in ${pronoun} left hand`, 'right hand': `in ${pronoun} right hand`, 'both hands': 'in both hands' }[hand] || '';
}

/**
 * "someone's wrist": the name swap for a person who is not drawn left a placeholder in the middle of a sentence. When ONE person
 * is drawn the body part is theirs; otherwise the possessive is simply dropped. Pure.
 */
export function withoutPlaceholderPossessives(value, onlyFigurePronoun = null) {
    return String(value || '')
        .replace(/\bsomeone['’]s\s+(?=(?:own\s+)?(?:wrist|hand|hands|arm|arms|shoulder|shoulders|back|head|hair|face|neck|chest|waist|hip|hips|leg|legs|foot|feet|fingers?|palm|palms|lap|side|ear|ears)\b)/gi, onlyFigurePronoun ? `${onlyFigurePronoun} ` : 'the ')
        .replace(/\bsomeone['’]s\b/gi, 'another person’s'.replace('another person’s', 'a'))
        .replace(/\s{2,}/g, ' ');
}

/**
 * The place a second time. The frame's location and the reply's setting often say the same thing in other words ("the modern
 * apartment foyer: polished floor ..., inside the modern apartment foyer in the morning under bright lights"; or, after the name
 * swap, "Modern luxury the luxury high-rise kitchen in bright morning sunlight"). The part of the setting that names the place
 * again is taken out; what is left (the hour, the weather) is kept only if it says something the place text and the light of
 * the frame do not already say. '' when nothing is left. Pure.
 */
export function placeOnce(placeText, around, light = '') {
    const extra = String(around || '').trim();
    if (!extra) return '';
    const label = String(placeText || '').split(':')[0].trim().replace(/^(?:the|a|an)\s+/i, '');
    let rest = extra;
    const hit = label ? new RegExp(`(?:the\\s+|a\\s+|an\\s+)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').exec(extra) : null;
    // Words in front of the place's name only described that name ("Modern luxury [the kitchen]"): they go with it.
    if (hit) rest = extra.slice(hit.index + hit[0].length);
    rest = rest.replace(/\s{2,}/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '').trim();
    if (!rest) return '';
    return newWords(rest, `${placeText} ${light}`) >= 2 ? rest : '';
}

/**
 * "pushes the matte black the sleek travel mug": the reader's own description of an object ("matte black Travel Mug")
 * plus the label the name was swapped for. When the words before the label are only that object's own descriptors,
 * the label alone stays. `objects` are set-book entries ({name, kind, label, look}). Pure.
 */
export function withoutDoubledLabels(text, objects) {
    let out = String(text || '');
    for (const o of objects || []) {
        if (o?.kind !== 'object' || !o.label || /^the (place|object)$/i.test(o.label)) continue;
        const label = /^(the|a|an)\b/i.test(o.label) ? o.label : `the ${o.label}`;
        const own = new Set(`${o.name} ${o.look}`.toLowerCase().match(/[a-z]+/g) || []);
        const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`(?:\\b(?:a|an|the)\\s+)?((?:[a-z-]+\\s+){1,3})(${esc})`, 'gi'), (all, adjectives, found) => {
            const ws = adjectives.toLowerCase().match(/[a-z]+/g) || [];
            return ws.length && ws.every((w) => own.has(w)) ? found : all;
        });
    }
    return out;
}
