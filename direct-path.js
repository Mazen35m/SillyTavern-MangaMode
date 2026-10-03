// The Direct path (the default planner since 1.1): the reader writes each frame's moment in plain words and
// lists what is VISIBLE in it; the code checks the answer (it never guesses what is missing - it names it),
// attaches the story's fixed data only for what the frame lists as visible, and compiles the prompt with NO
// model-specific patches. The whole prompt of every frame can be read back (assembleDirectFrame returns it).
// directToScene turns the answer into the scene the page planner, the balloons and the continuity books
// already read (the planner is the same code as before; Direct adds no frame, pose or event of its own).
// See docs/DIRECT.md.
//
// Guide rule: this file's guide (DIRECT_GUIDE) lists requirements only. A rule is added to it only
// after a recorded failure, with the failure and its test written next to it (RULE LOG at the bottom).
import { requestJson } from './llm-request.js';
import { extractSpeechLines, formatSpeechLines, resolveDialogueRefs } from './dialogue-lines.js';
import { formatKnownSet, matchPlace } from './set-book.js';
import { formatKnownCast, findPerson, mergeCast, uniqueLabels } from './cast-book.js';
import { formatWorld } from './world-book.js';
import { ANGLE_PHRASES } from './director.js';
import { sceneProblem } from './scene-parser.js';
import { namePairs, replaceNames, bare, sentence, plainLook, nounOf, tidy, WRITTEN_THING } from './prompt-builder.js';
import { layeredOutfit, NO_OUTFIT, withoutAbsences } from './text-rules.js';
import { repairLabelRuns, saidOnce } from './direct-text.js';

export const DIRECT_VERSION = 2;
export const DIRECT_TIMEOUT_MS = 120000;

export const SHOTS = ['extreme close-up', 'close-up', 'medium shot', 'full shot', 'wide shot'];
export const ANGLES = ['eye level', 'low angle', 'high angle', 'over the shoulder', 'pov', 'top-down view', 'ground-level view', 'dutch angle'];
export const KINDS = ['character', 'insert', 'establishing'];
export const PLACE_AMOUNTS = ['none', 'brief', 'full'];

const str = { type: 'string' };

/** The answer's shape. Order matters: the model writes in this order. */
export function buildDirectSchema({ maxFrames = 10, innerThoughts = true } = {}) {
    const frame = {
        type: 'object',
        additionalProperties: false,
        required: ['moment', 'shot', 'angle', 'kind', 'new_panel', 'emphasis', 'shows', 'place_name', 'light', 'dialogue_indices'],
        properties: {
            moment: str,
            shot: { type: 'string', enum: SHOTS },
            angle: { type: 'string', enum: ANGLES },
            kind: { type: 'string', enum: KINDS },
            new_panel: { type: 'boolean' },
            emphasis: { type: 'string', enum: ['normal', 'peak'] },
            shows: {
                type: 'object',
                additionalProperties: false,
                required: ['people', 'objects', 'place'],
                properties: {
                    people: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['name', 'parts', 'looks_at'],
                            properties: {
                                name: str,
                                parts: { type: 'array', items: str },
                                // Completes "<name> looks at ...": a person's name, an object, "the camera"; or "away" / "down" / "eyes closed". "" when the face is not visible.
                                looks_at: str,
                            },
                        },
                    },
                    objects: { type: 'array', items: str },
                    place: { type: 'string', enum: PLACE_AMOUNTS },
                },
            },
            place_name: str,
            light: str,
            dialogue_indices: { type: 'array', items: { type: 'integer' } },
        },
    };
    return {
        type: 'object',
        additionalProperties: false,
        required: ['frames', 'dialogue', 'new_cast', 'new_places', 'state'],
        properties: {
            frames: { type: 'array', items: frame, minItems: 1, maxItems: maxFrames },
            dialogue: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['line', 'speaker', 'bubble_type', 'text'],
                    properties: {
                        line: { type: 'integer' },
                        speaker: str,
                        bubble_type: { type: 'string', enum: innerThoughts ? ['speech', 'thought', 'inner', 'narration', 'shout', 'whisper'] : ['speech', 'thought', 'narration', 'shout', 'whisper'] },
                        text: str,
                    },
                },
            },
            new_cast: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'sex', 'label', 'look', 'outfit', 'outfit_changed', 'outfit_from_frame', 'same_as'],
                    properties: {
                        name: str, sex: { type: 'string', enum: ['female', 'male', 'other'] }, label: str, look: str, outfit: str,
                        // A KNOWN person whose clothes change in this reply: the new outfit, true, and the first frame (0-based) that shows it.
                        outfit_changed: { type: 'boolean' },
                        outfit_from_frame: { type: 'integer' },
                        // Someone the known cast lists under another name: that known name, else "".
                        same_as: str,
                    },
                },
            },
            new_places: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'kind', 'label', 'look'],
                    properties: { name: str, kind: { type: 'string', enum: ['place', 'object'] }, label: str, look: str },
                },
            },
            state: {
                type: 'object',
                additionalProperties: false,
                required: ['place', 'light', 'holding'],
                properties: {
                    place: str,
                    light: str,
                    holding: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['person', 'object', 'hand'], properties: { person: str, object: str, hand: str } } },
                },
            },
        },
    };
}

// ---------------------------------------------------------------- the guide (requirements only)

// Guide rules added after a recorded failure of the tuning scenes (RULE LOG at the bottom). Empty = requirements only.
export const DIRECT_RULES = [
    {
        id: 'R1-own-frame',
        text: 'One frame per visual moment of the message, in reading order: every sentence of the message that shows something new (an arrival, a movement, a gesture, a reaction) gets its own frame. A frame never merges two actions.',
        failure: 'T4 (tuning, 2026-10-03): in the two clean readings (runs 3 and 4) no frame showed the stated moment "strides into the elevator"; the frame drawn for it was a later one (turns, presses a button). Event "mid-stride" 0 of 3 images.',
        test: 'Re-read T4 with this rule: a frame whose moment is the stride into the elevator exists (checked by reading the answer); then rated blind.',
    },
    {
        id: 'R2-where-the-body-is',
        text: 'Say where each visible person is in the place: what they sit in, stand at, lean on or walk through (for example "in the driver\'s seat, one hand on the wheel").',
        failure: 'T6 (tuning): the key frame of a car scene said "close-up of Anna sliding on sunglasses, morning sun on the windshield" and never said she sits in the car; the picture put her outside beside the car in 3 of 3 seeds (event "inside a car" 0/3, "at the wheel" 0/3).',
        test: 'Re-read T6 with this rule: the key frame names the seat; then rated blind (inside the car).',
    },
    {
        id: 'R3-gaze',
        text: 'Say what each visible person looks at: a person, an object, or the camera.',
        failure: 'T3 (tuning): the chosen frame said the two "face" each other but not where each looks; Direct scored 0 of 3 on "they look at each other" (Moment 3/3, Classic 2 of 3).',
        test: 'Re-read T3 with this rule: the key frame says each person looks at the other; then rated blind.',
    },
    {
        id: 'R4-known-names',
        text: 'Write a known place or object by its name exactly as the known set lists it, with no description of your own in front of it (its look is attached for you).',
        failure: 'T4, T5, T6 (tuning answers, read again at closing): "her sleek black Travel Mug", "modern oversized black Designer Sunglasses", "dim, cavernous High-Rise Underground Garage" put the reader\'s adjectives in front of a name, and the name swap printed "sleek black the sleek travel mug", "black the designer sunglasses", "dim, cavernous the high-rise underground garage".',
        test: 'tests/direct-path.test.mjs: repairLabelRuns turns each of these runs into a sentence that says every word once; the saved answers assemble with no broken run.',
    },
    {
        id: 'R5-owner-of-the-body-part',
        text: 'Every hand, arm, leg or other body part in the moment belongs to a named person: write "her right hand" or "Anna\'s right hand", not "a hand", "the other hand" or "both hands", whenever two or more people are in the picture. When two people hold, give or take something together, say whose hand holds which part. Name a person once per sentence; say "he", "she", "his" or "her" after that.',
        failure: 'T5, T6, T2 (tuning answers, read again at closing): "One manicured hand", "one manicured arm", "both hands" in frames with two people; 7 of the 171 saved Direct frames had a body part with no owner while two or more people were in the picture. First live run of the closing build: the rule as first written ("write Anna\'s right hand") made the reader repeat the name up to five times in one sentence ("Anna rests Anna\'s right hand ... Anna\'s left hand ... Anna\'s hip"), which the name swap turned into a long label each time; the wording now allows pronouns, and the code turns a repeated "label\'s" in a sentence into the person\'s pronoun.',
        test: 'tests/direct-path.test.mjs: checkDirect names the body part without an owner (a retry asks the reader to fix it); repeatedPossessives turns the repeated label into a pronoun.',
    },
    {
        id: 'R6-camera-fields',
        text: 'Camera words (close-up, wide shot, medium shot, full shot) go only in "shot" and "angle", never in the moment text.',
        failure: 'T1, T6 (tuning answers, read again at closing): moments began "Extreme close-up on Anna\'s left wrist" and "Close-up of Anna sliding ..."; the page planner widens a close-up that carries a long speech, so the camera sentence and the moment then contradict each other.',
        test: 'tests/direct-path.test.mjs: checkDirect names a shot word inside a moment.',
    },
];

const GUIDE_BASE = `
YOUR JOB
You receive ONE reply written by a roleplay AI and plan how it is drawn as manhwa frames. For every frame you write the picture itself - "moment" - in plain words for an image model, and you list what is visible in it. The code attaches the fixed looks (people, objects, place) only for what you list, then sends your moment to the image model.

EACH FRAME
- "moment": 40-90 words, present tense, ONE picture: who does what, to what, where the hands and eyes are, how the people stand toward each other. Use the known cast's names exactly. Say whose hands and body parts are in the picture. Name only what is visible in this frame.
- "shows.people": every person visible in the frame, with the body parts that are visible ("face", "upper body", "hands", "legs", "whole body", "back of head"), and "looks_at": what that person looks at ("the camera", another person's name, an object; "away", "down" or "eyes closed" when the story says so; "" when the face is not visible).
- "shows.objects": every known object (from the known set) visible in the frame.
- "shows.place": "none" (the place is not recognisable in the picture, e.g. a close-up), "brief" (a hint of it behind the people), "full" (the place is the subject or clearly visible). "place_name" is the name of a known place or one you add in "new_places".
- "light": what lights this frame (hour, source, brightness, colour).
- "shot", "angle", "kind", "new_panel", "emphasis": the camera and the page. "new_panel" true starts a new panel; the first frame is true.
- "dialogue_indices": the balloons shown in the frame (indices into your "dialogue" array).

DIALOGUE
- The message's quoted lines and thoughts are already cut into numbered balloons (L0, L1, ...). Give every numbered balloon once, in order, with its speaker and its "line" number; a spoken line the list does not have has "line" -1.

NEW PEOPLE AND PLACES
- A person visible in a frame who is not in the known cast goes into "new_cast" once, with a "label" that has no name in it, a "look" (age, build, face, hair, eyes, skin) and an "outfit". A place or recurring object that is not in the known set goes into "new_places" once, with a fixed "look". Known ones are never described again. A KNOWN person whose clothes change in this reply goes into "new_cast" with the new outfit, "outfit_changed" true and "outfit_from_frame" (the 0-based number of the first frame that shows the new clothes); "same_as" is the known name when a known person is now called by another name.

STATE
- "state" says how the reply ends: the place, the light, and who holds what in which hand.
`.trim();

export const DIRECT_GUIDE = [GUIDE_BASE, ...(DIRECT_RULES.length ? [`ADDITIONAL REQUIREMENTS\n${DIRECT_RULES.map((r) => `- ${r.text}`).join('\n')}`] : [])].join('\n\n');

const POV_REQUIREMENT = `
FIRST PERSON
- The player is the camera and is not drawn. The player's own hands, arms or legs may be listed in "shows.people" under the player's name when they are in the picture; the player's face, head or whole body never are, and the moment never describes them.
`.trim();

/** The system prompt. */
export function directSystemPrompt({ maxFrames = 10, maxPanels = 6, povMode = false, guide = DIRECT_GUIDE } = {}) {
    return [
        'You are the storyboard artist of a manhwa (webtoon) adaptation of an interactive story.',
        guide,
        `LIMITS: at most ${maxFrames} frames, at most ${maxPanels} panels.`,
        povMode ? POV_REQUIREMENT : '',
    ].filter(Boolean).join('\n\n');
}

/** The user message: the same context blocks the classic reader gets (so the cost is comparable). */
export function directUserPrompt(messageText, { characterName, userName, world, knownCast, knownSet, knownState, sceneContext, speechLines } = {}) {
    const blocks = [];
    if (world) blocks.push('WORLD BOOK (how this story looks):', formatWorld(world), '');
    blocks.push('KNOWN CAST (use these names; their looks are fixed):', knownCast?.length ? formatKnownCast(knownCast, { personaName: userName }) : '(nobody yet)', '');
    blocks.push('KNOWN SET (places and objects already drawn; reuse these names):', knownSet?.length ? formatKnownSet(knownSet) : '(none yet)', '');
    const stateText = formatDirectState(knownState);
    if (stateText) blocks.push('STATE (how the previous reply ended; carry it forward unless this reply changes it):', stateText, '');
    if (sceneContext?.previousReply) blocks.push('CONTEXT ONLY - the end of the previous reply:', '"""', sceneContext.previousReply, '"""', '');
    if (sceneContext?.playerAction) blocks.push(`CONTEXT - the player's (${userName}) own message, which this reply answers:`, '"""', sceneContext.playerAction, '"""', '');
    blocks.push(`Reply written by: ${characterName}`, `The player is: ${userName}`, '', 'MESSAGE:', '"""', messageText, '"""', '');
    if (speechLines?.length) blocks.push('BALLOONS - the message\'s quoted lines and thoughts, already cut; refer to them by number:', formatSpeechLines(speechLines), '');
    blocks.push(`Storyboard this message as frames, following the schema. ${sceneContext?.playerAction ? `The first frame shows what the player (${userName}) does or says in their own message. ` : ''}The context blocks only tell you who is who and where; never draw events that happen only in the context.`);
    return blocks.join('\n');
}

// ---------------------------------------------------------------- validation (visible, never guessing)

const norm = (s) => String(s || '').trim().toLowerCase();
const wordsOf = (s) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w !== 's');

/** A known recurring object by the name the reader gave it: the same words, or all the words of one name inside the other's. Never a loose overlap. */
export function findObject(name, entries) {
    const w = new Set(wordsOf(name));
    if (!w.size) return null;
    let best = null;
    let bestScore = 0;
    for (const e of entries || []) {
        if (e?.kind !== 'object') continue;
        const ew = new Set(wordsOf(e.name));
        const inter = [...w].filter((x) => ew.has(x)).length;
        if (!inter) continue;
        const exact = inter === w.size && inter === ew.size;
        const within = inter === w.size || inter === ew.size;
        if (!exact && !within) continue;
        const score = exact ? 100 : inter;
        if (score > bestScore) { best = e; bestScore = score; }
    }
    return best;
}
const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
export const MOMENT_WORDS = { min: 15, max: 140 };

function mentionsName(text, person) {
    const esc = (n) => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = [person?.name, ...(person?.aliases || [])].filter((n) => String(n || '').trim().length >= 2);
    return names.some((n) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
}

const SHOT_WORD = /\b(?:extreme close-?up|close-?up|medium shot|full shot|wide shot|wide angle)\b/i;
// A body part with no owner: "the other hand", "a hand", "one manicured arm", "both hands" (a possessive or a name in front is an owner).
const UNOWNED_PART = /(?<!(?:\bhis|\bher|\btheir|\bits|\bmy|\byour|\bour|[\p{L}]['’]s)\s)\b(?:the|a|an|two|both|one|another|other)\s+(?:[\p{L}-]+\s+){0,2}?(?:hands?|arms?|fingers?|wrists?|palms?|legs?|feet|foot)\b/iu;
const FACE_PART = /\b(?:face|head|eyes?|whole|full|entire|portrait)\b/i;
const SEES_FACE = /\b(?:face|head|eyes?|upper body|whole|full|entire|portrait|bust|torso)\b/i;

/**
 * Checks a Direct answer against the story's books. `problems` are data errors (a name that does not exist, a missing
 * field, the player's face in first person): the reader must fix them, and an answer that still has them is an error.
 * `advice` are things the picture would lose (a visible face with no stated gaze, a body part with no owner, a shot word in
 * the moment): the reader is asked once to fix them, and what remains is kept and shown, never repaired by the code. Both are
 * sentences the reader can act on ("frame 3: ..."). Pure.
 * @param {object} content parsed JSON answer
 * @param {{cast: object[], setBook: object[], maxFrames?: number, personaName?: string, povMode?: boolean}} books
 * @returns {{problems: string[], advice: string[]}}
 */
export function checkDirect(content, { cast = [], setBook = [], maxFrames = 10, personaName = '', povMode = false } = {}) {
    const problems = [];
    const advice = [];
    const frames = Array.isArray(content?.frames) ? content.frames : null;
    if (!frames || !frames.length) return { problems: ['"frames" is missing or empty.'], advice };
    if (frames.length > maxFrames) problems.push(`There are ${frames.length} frames; at most ${maxFrames} are allowed.`);
    const everyone = mergeCast(cast || [], Array.isArray(content.new_cast) ? content.new_cast : []);
    const places = [...(setBook || []), ...(Array.isArray(content.new_places) ? content.new_places : [])];
    const dialogueCount = Array.isArray(content.dialogue) ? content.dialogue.length : 0;
    frames.forEach((f, i) => {
        const at = `frame ${i + 1}`;
        const words = wordCount(f.moment);
        if (!String(f.moment || '').trim()) problems.push(`${at}: "moment" is empty.`);
        else if (words < MOMENT_WORDS.min || words > MOMENT_WORDS.max) problems.push(`${at}: "moment" has ${words} words; write 40-90.`);
        if (!SHOTS.includes(f.shot)) problems.push(`${at}: "shot" "${f.shot}" is not one of: ${SHOTS.join(', ')}.`);
        if (!ANGLES.includes(f.angle)) problems.push(`${at}: "angle" "${f.angle}" is not one of: ${ANGLES.join(', ')}.`);
        if (!KINDS.includes(f.kind)) problems.push(`${at}: "kind" "${f.kind}" is not one of: ${KINDS.join(', ')}.`);
        const shows = f.shows || {};
        const people = Array.isArray(shows.people) ? shows.people : [];
        if (f.kind === 'character' && !people.length) problems.push(`${at}: kind is "character" but "shows.people" is empty.`);
        const listed = [];
        for (const p of people) {
            const found = findPerson(everyone, p?.name);
            // The player may be listed without a cast entry (their own hands, first person): nothing is attached then.
            const isPlayer = personaName && (norm(p?.name) === norm(personaName) || (found && norm(found.name) === norm(personaName)));
            if (!found && isPlayer) {
                if (povMode && (p.parts || []).some((x) => FACE_PART.test(x))) problems.push(`${at}: first person: the player is the camera; "${p.name}" may list hands, arms or legs, never face, head or whole body.`);
                continue;
            }
            if (!found) { problems.push(`${at}: "${p?.name}" in shows.people is not in the known cast or new_cast.`); continue; }
            listed.push(found);
            if (!Array.isArray(p.parts) || !p.parts.length) problems.push(`${at}: "${p.name}" has no visible body parts listed.`);
            if (isPlayer && povMode && (p.parts || []).some((x) => FACE_PART.test(x))) problems.push(`${at}: first person: the player is the camera; "${p.name}" may list hands, arms or legs, never face, head or whole body.`);
            else if (!isPlayer && f.kind !== 'insert' && (p.parts || []).some((x) => SEES_FACE.test(x)) && !String(p.looks_at || '').trim()) advice.push(`${at}: say what ${p.name} looks at ("looks_at"): a person, an object, "the camera", or "away" / "down" / "eyes closed".`);
        }
        if (people.length >= 2) {
            const m = String(f.moment || '').match(UNOWNED_PART);
            if (m) advice.push(`${at}: whose is "${m[0]}"? Write the owner ("Anna's right hand"), whenever two or more people are in the picture.`);
        }
        const shotWord = String(f.moment || '').match(SHOT_WORD);
        if (shotWord) advice.push(`${at}: the moment says "${shotWord[0]}"; camera words belong only in "shot" and "angle".`);
        // A person the moment names must be listed as visible (their fixed look is attached only for listed people).
        for (const c of everyone) {
            if (personaName && norm(c.name) === norm(personaName)) continue;
            if (mentionsName(String(f.moment || ''), c) && !listed.includes(c)) problems.push(`${at}: the moment names ${c.name}, who is not in shows.people.`);
        }
        for (const name of Array.isArray(shows.objects) ? shows.objects : []) {
            if (!findObject(name, places)) problems.push(`${at}: object "${name}" in shows.objects is not in the known set or new_places (add it to new_places once, or use the known name).`);
        }
        if (!PLACE_AMOUNTS.includes(shows.place)) problems.push(`${at}: "shows.place" must be none, brief or full.`);
        else if (shows.place !== 'none') {
            if (!String(f.place_name || '').trim()) problems.push(`${at}: shows.place is "${shows.place}" but "place_name" is empty.`);
            else if (!matchPlace(f.place_name, places, { strict: true })) problems.push(`${at}: place_name "${f.place_name}" is not in the known set or new_places.`);
        }
        for (const idx of Array.isArray(f.dialogue_indices) ? f.dialogue_indices : []) {
            if (!Number.isInteger(idx) || idx < 0 || idx >= dialogueCount) problems.push(`${at}: dialogue index ${idx} does not exist.`);
        }
    });
    if (!frames[0]?.new_panel) problems.push('The first frame must have new_panel true.');
    for (const c of Array.isArray(content.new_cast) ? content.new_cast : []) {
        if (!String(c.label || '').trim() || !String(c.look || '').trim()) problems.push(`new_cast "${c.name}": label and look must be filled.`);
    }
    for (const p of Array.isArray(content.new_places) ? content.new_places : []) {
        if (!String(p.look || '').trim()) problems.push(`new_places "${p.name}": look must be filled.`);
    }
    return { problems, advice };
}

/** The data errors of an answer ({@link checkDirect}'s `problems`). Pure. */
export function validateDirect(content, books = {}) {
    return checkDirect(content, books).problems;
}

// ---------------------------------------------------------------- selective fixed data

// What each visible body part brings with it. A frame that lists "hands" gets the cuff and the watch, not the skirt.
const GROUPS = {
    head: /\b(face|head|eyes?|hair|neck|mouth|lips|expression|portrait)\b/i,
    upper: /\b(upper body|torso|chest|bust|shoulders?|arms?|body|waist|whole|full|figure|person)\b/i,
    hands: /\b(hands?|fingers?|wrists?|palms?|forearms?|thumbs?)\b/i,
    lower: /\b(legs?|thighs?|knees?|lower body|hips?|whole|full|body|figure|person|standing|walking)\b/i,
    feet: /\b(feet|foot|shoes?|toes?|ankles?|whole|full|figure|person)\b/i,
    back: /\b(back of (?:the )?head|from behind|back)\b/i,
};
const ITEM_GROUPS = {
    head: /\b(hat|cap|helmet|hood|glasses|sunglasses|earrings?|necklace|choker|scarf|crown|mask|tiara|headband|collar|tie)\b/i,
    upper: /\b(shirt|t-shirt|blouse|top|jacket|coat|hoodie|sweater|vest|dress|robe|tunic|cardigan|armou?r|cuirass|breastplate|bodice|corset|cloak|cape|uniform|suit|gown|bra|sleeves?)\b/i,
    hands: /\b(gloves?|gauntlets?|bracers?|vambraces?|watch|wristwatch|bracelets?|bangles?|rings?|cuffs?|sleeves?|wristbands?|scrunchie)\b/i,
    lower: /\b(skirt|pants|trousers|jeans|shorts|leggings|dress|robe|kilt|greaves|tights|gown|uniform|suit|belt)\b/i,
    feet: /\b(shoes?|boots?|heels|sneakers|sandals|socks|stockings|loafers|slippers|sabatons|flip-flops|pumps)\b/i,
};
const BODY_TRAIT = /\b(bust|chest|waist|hips?|thighs?|build|frame|tall|short|slender|curvaceous|muscular|stocky|broad|lanky|petite|figure|legs?|shoulders?)\b/i;
const SKIN_AGE_TRAIT = /\b(skin|complexion|years?[- ]old|age|elderly|aged|young|teen\w*|human|elf|elven|dwarf|orc)\b/i;

/** Which groups the listed parts open. */
export function groupsOf(parts) {
    const text = (parts || []).join(' ; ');
    const out = new Set();
    for (const [g, re] of Object.entries(GROUPS)) if (re.test(text)) out.add(g);
    // "whole body" shows everything.
    if (/\b(whole|full|entire)\b/i.test(text)) ['head', 'upper', 'hands', 'lower', 'feet'].forEach((g) => out.add(g));
    if (out.has('upper')) out.add('hands'); // upper body shows the arms and cuffs
    return out;
}

/** The look traits and outfit pieces that belong to what is visible. Pure. */
export function visibleData(person, parts) {
    const groups = groupsOf(parts);
    const traits = bare(plainLook(bare(person.look))).split(',').map((t) => t.trim()).filter(Boolean);
    const kept = traits.filter((t) => {
        if (SKIN_AGE_TRAIT.test(t)) return true;
        if (BODY_TRAIT.test(t)) return groups.has('upper') || groups.has('lower');
        return groups.has('head') || groups.has('upper') || groups.has('back'); // face, hair, eyes, marks
    });
    let outfit = '';
    if (person.outfit && !NO_OUTFIT.test(String(person.outfit))) {
        const pieces = layeredOutfit(withoutAbsences(String(person.outfit))).split(',').map((t) => t.trim().replace(/^(?:and|with)\s+/i, '')).filter(Boolean);
        outfit = pieces.filter((t) => Object.entries(ITEM_GROUPS).some(([g, re]) => groups.has(g) && re.test(t))
            // A piece no group names (a plain label) is attached when the body is visible, never for hands alone.
            || (!Object.values(ITEM_GROUPS).some((re) => re.test(t)) && (groups.has('upper') || groups.has('lower')))).join(', ');
    }
    return { look: kept.join(', '), outfit, groups };
}

function labelOfEntry(entry, fallback) {
    const label = String(entry?.label || '').trim();
    if (label) return /^(the|a|an)\b/i.test(label) ? label : `the ${label}`;
    return fallback;
}

// Neutral shot words: the classic phrases say what the shot fills ("head and shoulders"), which contradicts a close-up of
// hands. What fills the picture is the moment's job here (DECISION 1 in the rule log).
const DIRECT_SHOT_PHRASES = {
    'extreme close-up': 'An extreme close-up.',
    'close-up': 'A close-up.',
    'medium shot': 'A medium shot.',
    'full shot': 'A full-body shot.',
    'wide shot': 'A wide shot.',
};
const cameraPhrase = ({ shot, angle }) => [DIRECT_SHOT_PHRASES[shot], ANGLE_PHRASES[angle]].filter(Boolean).join(' ');

const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
// Any statement of where somebody looks. A moment that has none gets the reader's own "looks_at" as a sentence.
const GAZE_WORD = /\b(?:look(?:s|ing|ed)?|gaze[sd]?|gazing|stare[sd]?|staring|glanc\w*|watch(?:es|ing)?|eyes?|locks?|locked|fix(?:es|ed|ing)?|glare[sd]?|glaring|peer\w*|squint\w*|eye contact)\b/i;

/** Which people the frame shows, as cast entries (the player apart), with the parts the reader listed. */
function listedPeople(frame, everyone, personaName) {
    const out = [];
    for (const p of frame.shows?.people || []) {
        const person = findPerson(everyone, p?.name);
        const isPlayer = personaName && (norm(p?.name) === norm(personaName) || (person && norm(person.name) === norm(personaName)));
        out.push({ raw: p, person, isPlayer: Boolean(isPlayer) });
    }
    return out;
}

/** The sentence for where one person looks, from the reader's "looks_at" ("" when it says nothing usable). */
function gazeSentence({ label, target, pairs }) {
    const t = String(target || '').trim().replace(/[.;,\s]+$/, '');
    if (!t) return '';
    const l = t.toLowerCase();
    if (/^(?:the\s+)?(?:camera|viewer|reader|audience|lens)$/.test(l)) return `${cap(label)} looks straight at the viewer.`;
    if (/^eyes?\s+(?:closed|shut)|^closed\b/.test(l)) return `${cap(label)}'s eyes are closed.`;
    if (/^(?:away|down|up|aside|past|off|elsewhere|ahead|forward|sideways|downward|upward)\b/.test(l)) return `${cap(label)} looks ${t}.`;
    // replaceNames capitalises a text that starts with a capital; the target is the middle of a sentence.
    const named = replaceNames(t, pairs).replace(/^(?:The|A|An)\b/, (m) => m.toLowerCase());
    return `${cap(label)} looks at ${/^(?:the|a|an|his|her|their|its|my|your|our)\b/i.test(named) ? '' : (/^\p{Lu}/u.test(named) && named === t ? '' : 'the ')}${named}.`.replace(/\s{2,}/g, ' ');
}

/**
 * One frame -> the image prompt. No model patches: the style prefix and suffix of the preset, the
 * camera sentence, the moment (names swapped for labels, the runs the swap breaks repaired), where each visible
 * person looks when the moment does not say, the place as much as the frame lists, the light, the look of every
 * listed object, and for every listed person only the look and outfit of the parts that are visible.
 * Returns {prompt, parts} - `parts` is what went in, for the log.
 * @param {object} frame a validated Direct frame
 * @param {{cast: object[], setBook: object[], personaName?: string, presets?: object, style?: string, pov?: boolean, frameIndex?: number, newCast?: object[], newPlaces?: object[]}} ctx
 *   style: the prompt style whose prefix/suffix is used (default "natural"); pov: the player is the camera (default true);
 *   frameIndex: this frame's 0-based position (a person's old outfit is worn before the frame that changes it).
 */
export function assembleDirectFrame(frame, ctx) {
    // With no new people the cast is used as given (it may carry a change of clothes made in this very reply).
    const everyone = ctx.newCast?.length ? mergeCast(ctx.cast || [], ctx.newCast) : (ctx.cast || []);
    const places = [...(ctx.setBook || []), ...(ctx.newPlaces || [])];
    const personaName = ctx.personaName || '';
    const pov = ctx.pov !== false;
    // In first person the player is the camera ("the viewer"); in third person the player is a person like any other.
    const isPersona = (p) => pov && personaName && norm(p.name) === norm(personaName);
    const preset = ctx.presets?.[ctx.style || 'natural'] || ctx.presets?.natural || {};

    // Names -> labels; the player is "the viewer" in first person.
    const pairs = namePairs(everyone.filter((p) => !isPersona(p)), places);
    if (pov && personaName) pairs.push({ name: personaName, label: 'the viewer', core: false });
    pairs.sort((a, b) => b.name.length - a.name.length);

    const shows = frame.shows || {};
    const parts = { camera: '', moment: '', gaze: [], setting: '', light: '', objects: [], people: [] };
    parts.camera = cameraPhrase({ shot: frame.shot, angle: frame.angle });
    // Every label that can stand in the text, with the words of its own look (an adjective the look already says is said once).
    const labelled = [
        ...everyone.filter((p) => !isPersona(p)).map((p) => ({ label: p.label, own: `${p.look || ''} ${p.outfit || ''}`, sex: p.sex })),
        ...places.map((e) => ({ label: labelOfEntry(e, ''), own: `${e.name || ''} ${e.look || ''}` })),
    ].filter((e) => e.label);
    const swapped = replaceNames(bare(frame.moment), pairs);
    parts.moment = sentence(saidOnce(repairLabelRuns(swapped, labelled)));

    // Where each visible person looks: the reader's own words, added only when the moment says nothing about eyes at all.
    const listed = listedPeople(frame, everyone, personaName);
    if (!GAZE_WORD.test(String(frame.moment || ''))) {
        for (const { raw, person, isPlayer } of listed) {
            if (!person || (isPlayer && pov) || frame.kind === 'insert') continue;
            if (!(raw.parts || []).some((x) => SEES_FACE.test(x))) continue;
            const text = gazeSentence({ label: labelOfEntry(person, 'the person'), target: raw.looks_at, pairs });
            if (text) parts.gaze.push(text);
        }
    }

    if (shows.place && shows.place !== 'none') {
        const place = matchPlace(frame.place_name, places, { strict: true });
        if (place) {
            const label = labelOfEntry(place, '');
            const look = bare(place.look);
            const text = shows.place === 'full' ? [label, look].filter(Boolean).join(': ') : [label, look.split(',').slice(0, 3).join(',').trim()].filter(Boolean).join(': ');
            if (text) parts.setting = `Setting: ${text}.`;
        }
    }
    if (String(frame.light || '').trim()) parts.light = `Lighting: ${bare(frame.light)}.`;

    // Listed objects, by name (exact words of the set book).
    const seen = new Set();
    for (const name of shows.objects || []) {
        const entry = findObject(name, places);
        if (!entry || seen.has(entry)) continue;
        seen.add(entry);
        const label = labelOfEntry(entry, 'a recurring object');
        parts.objects.push(`${cap(label)}: ${bare(entry.look)}.`);
    }

    for (const { raw: p, person, isPlayer } of listed) {
        if (!person && isPlayer && pov) { parts.people.push(`The viewer's own ${(p.parts || []).join(' and ')}.`); continue; }
        if (!person) continue;
        // A person who changes clothes in the middle of the reply wears the old clothes before the frame that shows the new ones.
        const outfit0 = person.outfitBefore && Number.isInteger(ctx.frameIndex) && person.outfitFromBeat > ctx.frameIndex ? { ...person, outfit: person.outfitBefore } : person;
        const { look, outfit } = visibleData(outfit0, p.parts);
        const noun = nounOf(person);
        const bodyText = [look, outfit ? `wearing ${outfit}` : ''].filter(Boolean).join('; ');
        if (isPlayer && pov) {
            parts.people.push(`The viewer's own ${(p.parts || []).join(' and ')} (${noun.replace(/^an? /, '')}${bodyText ? `; ${bodyText}` : ''}).`);
        } else {
            parts.people.push(`${cap(labelOfEntry(person, 'the person'))} is ${noun}${bodyText ? `: ${bodyText}` : ''}.`);
        }
    }

    const body = tidy([parts.camera, parts.moment, ...parts.gaze, parts.setting, parts.light, ...parts.objects, ...parts.people].filter(Boolean).join(' '));
    const prompt = [String(preset.prefix || '').trim(), body, String(preset.suffix || '').trim()].filter(Boolean).join(' ');
    return { prompt, parts };
}

// ---------------------------------------------------------------- state carried to the next reply

const clip = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const HANDS = ['left hand', 'right hand', 'both hands'];

/** The state a reply ends in: where, the light, who holds what in which hand. null when it says nothing. Pure. */
export function cleanDirectState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const place = clip(raw.place, 120);
    const light = clip(raw.light, 120);
    const holding = (Array.isArray(raw.holding) ? raw.holding : [])
        .map((h) => ({ person: clip(h?.person, 60), object: clip(h?.object, 80), hand: HANDS.includes(clip(h?.hand, 20).toLowerCase()) ? clip(h.hand, 20).toLowerCase() : '' }))
        .filter((h) => h.person && h.object).slice(0, 12);
    // A state saved by the moment-cards planner (objects and spots) is still read.
    const objects = (Array.isArray(raw.objects) ? raw.objects : []).map((o) => ({ object: clip(o?.object, 80), where: clip(o?.where, 120) })).filter((o) => o.object && o.where).slice(0, 12);
    const spots = (Array.isArray(raw.spots) ? raw.spots : []).map((x) => ({ person: clip(x?.person, 60), spot: clip(x?.spot, 120) })).filter((x) => x.person && x.spot).slice(0, 8);
    return place || light || holding.length || objects.length || spots.length ? { place, light, holding, ...(objects.length ? { objects } : {}), ...(spots.length ? { spots } : {}) } : null;
}

/** The STATE block of the reader's message. */
export function formatDirectState(state) {
    const s = cleanDirectState(state);
    if (!s) return '';
    const lines = [];
    if (s.place) lines.push(`- place: ${s.place}`);
    if (s.light) lines.push(`- light: ${s.light}`);
    for (const h of s.holding) lines.push(`- ${h.person} holds ${h.object}${h.hand ? ` (${h.hand})` : ''}`);
    for (const o of s.objects || []) lines.push(`- ${o.object}: ${o.where}`);
    for (const x of s.spots || []) lines.push(`- ${x.person} is ${x.spot}`);
    return lines.join('\n');
}

/** The state the last earlier reply that had one ended with. Pure. */
export function findKnownDirectState(chat, messageId, lookback = 12) {
    for (let i = messageId - 1; i >= Math.max(0, messageId - lookback); i--) {
        const state = cleanDirectState(chat?.[i]?.extra?.manga?.scene?.state);
        if (state) return state;
    }
    return null;
}

// ---------------------------------------------------------------- the scene the planner reads

/**
 * The Direct answer as the scene the page planner, the balloons and the continuity books read. Every frame the reader wrote is
 * one beat; nothing is added, merged or re-posed here (the older completion steps are not applied). Each beat keeps the reader's
 * frame under `direct`, so the prompt is assembled from it at draw time with the camera the planner finally uses. Pure.
 * @param {object} content the parsed answer (dialogue already resolved)
 * @param {{knownCast?: object[], personaName?: string, advice?: string[]}} [meta]
 */
export function directToScene(content, { knownCast = [], personaName = '', advice = [] } = {}) {
    const everyone = mergeCast(knownCast, content.new_cast || []);
    const people = new Map();
    const beats = (content.frames || []).map((f, i) => {
        const characters = [];
        for (const p of f.shows?.people || []) {
            const found = findPerson(everyone, p?.name);
            const name = found?.name || (personaName && norm(p?.name) === norm(personaName) ? personaName : String(p?.name || '').trim());
            if (name && !characters.some((n) => norm(n) === norm(name))) characters.push(name);
            if (name && !people.has(norm(name))) people.set(norm(name), name);
        }
        const peak = f.emphasis === 'peak';
        return {
            frameIndex: i,
            kind: f.kind,
            description: f.moment,
            camera: { shot: f.shot, angle: f.angle },
            new_panel: i === 0 ? true : Boolean(f.new_panel),
            emphasis: peak ? 'main' : 'normal',
            intensity: peak ? 'peak' : 'calm',
            same_moment: false,
            sfx: '',
            location: String(f.place_name || ''),
            light: String(f.light || ''),
            characters,
            people: [],
            dialogue_indices: Array.isArray(f.dialogue_indices) ? f.dialogue_indices : [],
            direct: { moment: f.moment, shot: f.shot, angle: f.angle, kind: f.kind, shows: f.shows, place_name: f.place_name, light: f.light },
        };
    });
    return {
        parserVersion: 6,
        pipeline: 'direct',
        directVersion: DIRECT_VERSION,
        setting: clip(content.state?.place || beats.find((b) => b.location)?.location || '', 160),
        cast: (content.new_cast || []).map((c) => ({ ...c, outfit_from_beat: c.outfit_from_frame })),
        places: content.new_places || [],
        dialogue: content.dialogue || [],
        beats,
        characters: [...people.values()].map((name) => ({ name, screen_position: 'center' })),
        state: cleanDirectState(content.state),
        ...(advice.length ? { warnings: advice } : {}),
    };
}

/** The Direct frame of a planned beat, with the camera the planner finally chose. */
export function frameOfBeat(spec, camera) {
    const d = spec?.direct;
    if (!d) return null;
    return { ...d, shot: camera?.shot || d.shot, angle: camera?.angle || d.angle };
}

/**
 * What the quality check should find in the finished picture of a Direct frame: the listed people with the look of what is
 * visible, what happens (the moment, names as labels), where each looks when that is another person or the viewer, the kind.
 * Same shape as the classic expectation, so the checker is the same code. Pure.
 */
export function directExpectation(spec, camera, ctx) {
    const frame = frameOfBeat(spec, camera);
    if (!frame) return { text: '', gazes: [], together: false, labels: [], kind: 'character', forCrop: false, writing: false, contact: false, crowd: false };
    const everyone = ctx.cast || [];
    const places = ctx.setBook || [];
    const personaName = ctx.personaName || '';
    const pov = ctx.pov !== false;
    const pairs = namePairs(everyone.filter((p) => !(pov && personaName && norm(p.name) === norm(personaName))), places);
    if (pov && personaName) pairs.push({ name: personaName, label: 'the viewer', core: false });
    pairs.sort((a, b) => b.name.length - a.name.length);
    const listed = listedPeople(frame, everyone, personaName);
    const figures = listed.filter((l) => l.person && !(l.isPlayer && pov));
    const ownHands = pov && listed.some((l) => l.isPlayer);
    const insert = frame.kind === 'insert';
    const lines = [];
    if (ownHands) lines.push('Hands: this is a first-person view - hands reaching in from the bottom edge are the viewer\'s own. That is correct here, not a defect.');
    lines.push(`Frame kind: ${insert ? 'a close-up of hands and an object' : frame.kind === 'establishing' ? 'a wide view of a place (people small or absent)' : frame.shot}.`);
    if (figures.length) {
        lines.push(`Main figures (exactly ${figures.length}):`);
        for (const { raw, person } of figures) {
            const { look, outfit } = visibleData(person, raw.parts);
            lines.push(`- "${person.label}": ${[look, outfit ? `wearing ${outfit}` : ''].filter(Boolean).join('; ') || 'no stated look'}.`);
        }
    } else {
        lines.push('Main figures: none.');
    }
    const gazes = [];
    if (!insert) {
        for (const { raw, person } of figures) {
            const t = String(raw.looks_at || '').trim();
            if (!t || !(raw.parts || []).some((x) => SEES_FACE.test(x))) continue;
            if (/^(?:the\s+)?(?:camera|viewer|reader|audience|lens)$/i.test(t)) { gazes.push({ label: person.label, target: 'the viewer' }); continue; }
            const other = figures.find((g) => g.person !== person && findPerson([g.person], t));
            if (other) gazes.push({ label: person.label, target: other.person.label });
        }
    }
    for (const g of gazes) lines.push(`Gaze: "${g.label}" must be looking at ${g.target === 'the viewer' ? 'the camera' : `the face of "${g.target}"`} (not down at an object, not elsewhere).`);
    const moment = sentence(saidOnce(repairLabelRuns(replaceNames(bare(frame.moment), pairs), [...everyone.map((p) => ({ label: p.label, own: `${p.look || ''} ${p.outfit || ''}`, sex: p.sex })), ...places.map((e) => ({ label: labelOfEntry(e, ''), own: `${e.name || ''} ${e.look || ''}` }))])));
    if (moment) lines.push(`What happens: ${moment}`);
    return { text: lines.join('\n'), gazes, together: false, labels: insert ? [] : figures.map((f) => f.person.label), kind: frame.kind, forCrop: false, writing: WRITTEN_THING.test(String(frame.moment || '')), contact: false, crowd: false };
}

// ---------------------------------------------------------------- the call

/**
 * Reads one reply the Direct way: one structured call, a check, and at most ONE corrective retry that lists what is wrong
 * (data errors and things the picture would lose). A data error that remains throws a visible error with the problems in it
 * (never a silent repair); advice that remains is kept with the scene (`warnings`) and drawing goes on.
 * @returns {Promise<{content: object, problems: string[], advice: string[], usage: object, attempts: object[]}>}
 */
export async function parseDirect(context, connectionProfileId, messageText, meta = {}) {
    if (!connectionProfileId) throw new Error('No Connection Profile selected for the Manga Scene Parser. Set one in Manga Mode settings.');
    const maxFrames = meta.maxImages || meta.maxFrames || 10;
    const budget = { maxFrames, maxPanels: meta.maxPanels || 6, povMode: Boolean(meta.povMode), guide: meta.guide || DIRECT_GUIDE };
    const speech = extractSpeechLines(messageText);
    const messages = [
        { role: 'system', content: directSystemPrompt(budget) },
        { role: 'user', content: directUserPrompt(messageText, { ...meta, speechLines: speech }) },
    ];
    const books = { cast: meta.knownCast || [], setBook: meta.knownSet || [], maxFrames, personaName: meta.userName || '', povMode: Boolean(meta.povMode) };
    const attempts = [];
    let usage = null;
    const send = meta.requestJson || requestJson;
    const call = async (msgs) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
        try {
            return await send(context, connectionProfileId, msgs, 12000, {
                name: 'manga_direct', description: 'Frames of one roleplay reply, each with its own moment.',
                value: buildDirectSchema({ maxFrames, innerThoughts: meta.innerThoughts !== false }), strict: true,
            }, { signal: controller.signal, reasoningEffort: meta.reasoningEffort || 'minimal', label: 'The scene director (direct)', cacheSystem: true });
        } catch (error) {
            if (controller.signal.aborted) throw new Error(`Scene director gave no answer within ${DIRECT_TIMEOUT_MS / 1000}s (timed out).`);
            throw error;
        } finally { clearTimeout(timer); }
    };
    const addUse = (u) => {
        if (!u) return;
        usage = usage ? Object.fromEntries(Object.keys({ ...usage, ...u }).map((k) => [k, (typeof (usage[k] ?? 0) === 'number' ? (usage[k] || 0) + (u[k] || 0) : u[k])])) : { ...u };
    };
    let result = await call(messages);
    addUse(result.usage);
    let checked = checkDirect(result.content, books);
    attempts.push({ content: result.content, problems: checked.problems, advice: checked.advice, usage: result.usage });
    if (checked.problems.length || checked.advice.length) {
        const first = { result, checked };
        const wanted = [...checked.problems, ...checked.advice];
        const retry = [...messages,
            { role: 'assistant', content: JSON.stringify(result.content) },
            { role: 'user', content: `Your answer has these problems:\n- ${wanted.join('\n- ')}\nReturn the whole answer again with every problem fixed.` }];
        try {
            const again = await call(retry);
            addUse(again.usage);
            const recheck = checkDirect(again.content, books);
            attempts.push({ content: again.content, problems: recheck.problems, advice: recheck.advice, usage: again.usage });
            // The second answer replaces the first unless it broke something the first had right.
            if (recheck.problems.length <= checked.problems.length && !(recheck.problems.length && !checked.problems.length)) { result = again; checked = recheck; }
        } catch (error) {
            // A failed retry costs nothing that was already paid for: with no data error the first answer stands.
            if (checked.problems.length) throw Object.assign(error, { usage: error.usage || usage, attempts });
            console.warn('[Manga Mode] The corrective retry failed; the first reading is used:', error);
        }
    }
    if (checked.problems.length) {
        const error = new Error(`The Direct reader returned an answer with problems: ${checked.problems.slice(0, 5).join(' | ')}`);
        error.problems = checked.problems;
        error.usage = usage;
        error.attempts = attempts;
        throw error;
    }
    // resolveDialogueRefs works on "beats"; the Direct answer calls them "frames".
    const resolved = resolveDialogueRefs({ ...result.content, beats: result.content.frames }, speech, { fallbackSpeaker: meta.characterName || '' });
    const content = { ...result.content, frames: resolved.beats, dialogue: resolved.dialogue };
    return { content, problems: checked.problems, advice: checked.advice, usage, attempts, state: cleanDirectState(result.content.state), cast: uniqueLabels(mergeCast(meta.knownCast || [], result.content.new_cast || [])) };
}

/**
 * The scene of one reply, ready for the page planner: read (parseDirect), then converted (directToScene). The usage of every attempt
 * is on the scene as a non-enumerable `__usage`, like the other readers'.
 */
export async function parseDirectScene(context, connectionProfileId, messageText, meta = {}) {
    const parsed = await parseDirect(context, connectionProfileId, messageText, meta);
    const scene = directToScene(parsed.content, { knownCast: meta.knownCast || [], personaName: meta.userName || '', advice: parsed.advice });
    const problem = sceneProblem(scene);
    if (problem) {
        const error = new Error(`The scene director returned an unusable scene: ${problem}.`);
        error.usage = parsed.usage;
        throw error;
    }
    Object.defineProperty(scene, '__usage', { value: parsed.usage, enumerable: false });
    return scene;
}

// ---------------------------------------------------------------- RULE LOG
// The guide is requirements only plus the DIRECT_RULES above: each rule carries the tuning scene that failed, the evidence and
// the test that checks it (a rule is added only for a failure recorded in the TUNING set; validation scenes never add rules).
// Round 1 of the tuning ran with DIRECT_RULES empty; the three rules were added after its blind rating (docs/DIRECT.md).
//
// CODE DECISIONS (not guide rules), made before any run:
// 1. Shot words are neutral ("A close-up."), not the classic "head and shoulders fill the picture":
//    found while writing the first assembly test (a hands close-up got a portrait sentence).
// 3. A word the name swap repeats ("ceramic ceramic coffee cup") is said once (found in the tuning prompts).
// 2. A known object is found by the reader's own name for it (same words, or one name inside the other), never by a loose
//    word overlap, and an object that is neither known nor in new_places is a visible problem. Found in the first assembled
//    prompts of the tuning scenes ("Volvo Sedan" pulled the look of the bag-and-keys by the shared word "Volvo"; the same line
//    printed twice). The set-book name swap printed "matte black the sleek travel mug": the existing label-doubling cleaner
//    (moment-cards.js) is applied to the moment. A comma-"and" outfit piece lost its leading "and".
// 4. Sentence repair (direct-text.js): adjectives the reader put in front of a name move behind the label's article, an
//    article after a possessive is dropped, and an adjective the label already says is said once. Found in the 171 saved
//    answers ("sleek black the designer sunglasses", "dim, cavernous the high-rise underground garage"); it only re-orders and
//    de-duplicates, it never adds a word, and verbs are never touched.
// 5. A person named twice in one sentence: the second "label's" becomes her/his/their ("rests the long label's right hand" ->
//    "rests her right hand"). Found in the first live run of the closing build. Skipped when another person of the same
//    pronoun is in the sentence (it could mean either).
// 6. One outfit per person (cast-book.js oneOutfit): a bible entry "...; alternatively a deep red silk robe" made the image
//    model draw both, even a second woman in the robe. Found in the second live reply; fixed in the data, for every path.
// 7. Looks-at: a frame lists who each visible person looks at; when the moment has no gaze word the code adds the sentence
//    from that field (never an invented glance). Missing looks_at, an unowned body part or a shot word in the moment are
//    advice (one retry, then drawn anyway with the warning kept), data errors are hard problems (one retry, then a visible error).
