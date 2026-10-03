import { chooseLayout, frameGenerationSize, MAX_FRAMES } from './page-layout.js';
import { sameName } from './cast-book.js';
import { placeWords } from './util.js';
import { momentCamera } from './moment-cards.js';

// Phase 4: Visual Director. Turns one parsed scene into an ordered list of webtoon panels and
// decides - in code, not by asking the model - how each panel is produced:
//
//   generate   one ComfyUI generation for this panel                       (1x cost)
//   reframe    a closer crop of the previous panel's image, same instant   (free)
//   split      one image shown as two panels (full frame, then a closer
//              crop), used when a single beat carries too much dialogue    (free)
//   full-bleed a rendering mode for a rare peak moment - viewport-height,
//              large gutters; rationed by a cooldown computed from chat history
//
// The LLM only proposes beats (the scene parser's optional `panels` array); everything that has to
// be rationed or kept consistent (panel count, the full-bleed cooldown, dialogue order) is enforced
// here, because asked "is this dramatic?" a model says yes nearly every time.

export const SHOT_TAGS = {
    'extreme close-up': 'extreme close-up, face focus',
    'close-up': 'close-up, portrait',
    'medium shot': 'upper body, cowboy shot',
    'full shot': 'full body',
    'wide shot': 'wide shot, full body, scenery',
};

export const ANGLE_TAGS = {
    'eye level': '',
    'low angle': 'from below',
    'high angle': 'from above',
    'over the shoulder': 'over shoulder',
    pov: 'pov',
    // 1.12: a wider vocabulary for the camera. Each is a plain composition word the image model knows.
    'top-down view': 'from above, bird\'s-eye view',
    'ground-level view': 'from below, worm\'s-eye view',
    'dutch angle': 'dutch angle',
    'from behind': 'from behind',
    'profile view': 'from side, profile',
    'through foreground': 'foreground, depth of field',
};

const SHOT_ORDER = ['wide shot', 'full shot', 'medium shot', 'close-up', 'extreme close-up'];

export { SHOT_ORDER };

/** Generation size per framing - webtoon panels are not all the same shape. SDXL-native buckets. */
export function sizeForPanel(camera, fullBleed, defaults, peopleCount = 1) {
    if (fullBleed) return { width: 832, height: 1216 };
    switch (camera?.shot) {
        // Landscape only for at most one person: with two or more, fixed-seed tests (e5) dropped or
        // merged people far more often in 1216x832 than in the portrait bucket.
        case 'wide shot': return peopleCount <= 1 ? { width: 1216, height: 832 } : { width: defaults.width, height: defaults.height };
        case 'extreme close-up': return { width: 1216, height: 832 };
        case 'close-up': return { width: 1024, height: 1024 };
        default: return { width: defaults.width, height: defaults.height };
    }
}

/**
 * Dialogue indices per panel: every line exactly once, in order, panels never going backwards.
 * Lines the model forgot are attached to the panel holding the nearest earlier line.
 */
export function normalizeDialogueAssignment(panelSpecs, dialogueCount) {
    const owner = new Array(dialogueCount).fill(-1);
    panelSpecs.forEach((spec, p) => {
        for (const raw of spec?.dialogue_indices || []) {
            const i = Number(raw);
            if (Number.isInteger(i) && i >= 0 && i < dialogueCount && owner[i] === -1) owner[i] = p;
        }
    });
    let current = 0;
    for (let i = 0; i < dialogueCount; i++) {
        if (owner[i] === -1 || owner[i] < current) owner[i] = current; // fill gaps, forbid going back
        current = owner[i];
    }
    return panelSpecs.map((_, p) => owner.map((o, i) => (o === p ? i : -1)).filter((i) => i >= 0));
}

/**
 * How many assistant messages back the last full-bleed panel was - computed from the chat itself,
 * so there is no second copy of state to drift. Infinity if none within the window.
 */
export function messagesSinceFullBleed(chat, messageId, window = 50, pending = null) {
    let seen = 0;
    // Check both directions: a full-bleed a few replies AFTER this one (regenerating an older
    // message) spoils the contrast just as much as one before it.
    const hasFullBleed = (m) => m?.extra?.manga?.panels?.some((p) => p.fullBleed) || (pending && pending.has(m));
    let nearest = Infinity;
    for (let i = messageId - 1; i >= 0 && seen < window; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        seen++;
        if (hasFullBleed(m)) { nearest = seen; break; }
    }
    seen = 0;
    for (let i = messageId + 1; i < chat.length && seen < window && seen < nearest; i++) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        seen++;
        if (hasFullBleed(m)) { nearest = Math.min(nearest, seen); break; }
    }
    return nearest;
}

/**
 * How much a beat is worth keeping when the reply has more beats than the budget allows. Dialogue
 * weighs most (a dropped beat's lines move to a neighbour, but the moment they belong to is lost),
 * then drama and the parser's own emphasis. A beat that only shows the player standing there is
 * worth the least - it is what made the player look like an NPC.
 * The old rule ("always keep the first and the last") kept "the door shuts, you stand alone" and
 * threw away the whole porch scene with three lines of dialogue (Vanessa chat, 2026-09-25).
 */
export function beatValue(spec, { playerName = '' } = {}) {
    const lines = Array.isArray(spec?.dialogue_indices) ? spec.dialogue_indices.length : 0;
    const people = Array.isArray(spec?.characters) ? spec.characters : [];
    let value = lines * 2 + ({ peak: 3, tense: 1 }[spec?.intensity] || 0) + ({ main: 2, minor: -1 }[spec?.emphasis] || 0);
    if (spec?.kind === 'establishing') value += 1.5;
    if (spec?.kind === 'insert') value += 0.5;
    const onlyPlayer = people.length === 1 && playerName && String(people[0]).toLowerCase() === String(playerName).toLowerCase();
    if (onlyPlayer && !lines) value -= 3;
    return value;
}

/** Beats grouped into panels by the parser's `new_panel` flag (absent = a panel of its own). */
export function groupBeats(specs) {
    const groups = [];
    specs.forEach((spec, i) => {
        const last = groups[groups.length - 1];
        if (i === 0 || spec.new_panel !== false || !last || last.length >= MAX_FRAMES) groups.push([spec]);
        else last.push(spec);
    });
    return groups;
}

/** The shot a frame is really drawn with: its lettering can widen a close-up (shotForWords). */
function drawnShot(spec, { dialogue = [], defaultCamera = null } = {}) {
    const camera = spec?.camera || defaultCamera;
    return shotForWords(camera, wordsOf(spec?.dialogue_indices, dialogue))?.shot;
}

/**
 * How many images the groups cost - counted the way planPanels decides it, not a simpler way: a frame
 * is a free crop only when it is the same moment as the frame before it and really CLOSER (judged on
 * the shot its lettering leaves it - a close-up with a long speech becomes a medium shot, which is no
 * closer and must be drawn); the first frame of a grid page and a full-bleed frame are always drawn.
 * (1.07 counted from the parser's raw cameras, so maxImages=1 could give two images.)
 */
function imageCost(groups, ctx = {}) {
    let cost = 0;
    let previous = null;
    groups.forEach((group, g) => group.forEach((spec, f) => {
        const shot = drawnShot(spec, ctx);
        let free = false;
        if (previous && spec?.same_moment) {
            const closer = SHOT_ORDER.indexOf(shot) > SHOT_ORDER.indexOf(previous.shot);
            free = group.length === 1 ? g > 0 && closer && !(ctx.canFullBleed && spec.intensity === 'peak') : f > 0 && closer;
        }
        if (!free) cost++;
        previous = { shot };
    }));
    return cost;
}

/** Removes one frame; its dialogue goes to a neighbour in the same panel, else the nearest panel. */
function dropFrame(groups, g, f) {
    const spec = groups[g][f];
    const lines = [...(spec.dialogue_indices || [])];
    const target = groups[g][f - 1] || groups[g][f + 1] || groups[g - 1]?.[groups[g - 1].length - 1] || groups[g + 1]?.[0];
    if (target && lines.length) target.dialogue_indices = [...(target.dialogue_indices || []), ...lines].sort((a, b) => a - b);
    groups[g].splice(f, 1);
    if (!groups[g].length) groups.splice(g, 1);
}

function lowestFrame(groups, playerName) {
    let best = null;
    groups.forEach((group, g) => group.forEach((spec, f) => {
        if (g === 0 && f === 0) return; // the first frame establishes the reply
        const value = beatValue(spec, { playerName });
        if (!best || value < best.value) best = { g, f, value };
    }));
    return best;
}

/**
 * Fits the parser's beats into the budget: at most `maxImages` generated images and `maxPanels`
 * panels of at most 3 frames. Over the panel budget, neighbouring panels are merged into one
 * multi-frame panel first (nothing is lost); only when nothing can merge is the least valuable
 * beat dropped - never its dialogue.
 * @returns {object[][]} panels -> frames (copies of the specs)
 */
export function fitBudget(specs, { maxPanels = 6, maxImages = 10, playerName = '', dialogue = [], defaultCamera = null, canFullBleed = false } = {}) {
    const groups = groupBeats(specs.map((s) => ({ ...s, dialogue_indices: [...(s.dialogue_indices || [])] })));
    const cost = { dialogue, defaultCamera, canFullBleed };
    let guard = 100;
    while (imageCost(groups, cost) > Math.max(1, maxImages) && guard-- > 0) {
        const low = lowestFrame(groups, playerName);
        if (!low) break;
        dropFrame(groups, low.g, low.f);
    }
    while (groups.length > Math.max(1, maxPanels) && guard-- > 0) {
        let best = null;
        for (let i = 0; i + 1 < groups.length; i++) {
            if (groups[i].length + groups[i + 1].length > MAX_FRAMES) continue;
            const value = [...groups[i], ...groups[i + 1]].reduce((sum, spec) => sum + beatValue(spec, { playerName }), 0);
            const samePlace = String(groups[i][0].location || '') === String(groups[i + 1][0].location || '');
            const cost = value + (samePlace ? 0 : 2);
            if (!best || cost < best.cost) best = { i, cost };
        }
        if (best) {
            const merged = [...groups[best.i], ...groups[best.i + 1]];
            // One key frame per panel: keep the most valuable "main".
            const mains = merged.filter((spec) => spec.emphasis === 'main');
            if (mains.length > 1) {
                const keep = mains.reduce((a, b) => (beatValue(b, { playerName }) > beatValue(a, { playerName }) ? b : a));
                merged.forEach((spec) => { if (spec.emphasis === 'main' && spec !== keep) spec.emphasis = 'normal'; });
            }
            groups.splice(best.i, 2, merged);
        } else {
            const low = lowestFrame(groups, playerName);
            if (!low) break;
            dropFrame(groups, low.g, low.f);
        }
    }
    // A frame is half the column or less: a long exchange buried it under balloons (Vanessa #2,
    // 5 lines over two half-width frames covered ~40% of the art). While the panel budget allows,
    // the frame with the most lines gets a panel of its own.
    const linesIn = (spec) => (spec.dialogue_indices || []).length;
    for (let g = 0; g < groups.length && groups.length < Math.max(1, maxPanels); g++) {
        const group = groups[g];
        if (group.length < 2) continue;
        const heaviest = group.reduce((best, spec, i) => (linesIn(spec) > linesIn(group[best]) ? i : best), 0);
        if (linesIn(group[heaviest]) <= 3) continue;
        const parts = [group.slice(0, heaviest), [group[heaviest]], group.slice(heaviest + 1)].filter((part) => part.length);
        // Only while the result still fits BOTH budgets: three parts could make two panels too many, and
        // the first frame of a part is always drawn (a free crop that starts a part costs an image).
        if (groups.length - 1 + parts.length > Math.max(1, maxPanels)) continue;
        const trial = [...groups.slice(0, g), ...parts, ...groups.slice(g + 1)];
        if (imageCost(trial, cost) > Math.max(1, maxImages)) continue;
        groups.splice(g, 1, ...parts);
        g += parts.length - 1;
    }
    return groups;
}

/** Loose "same place" test: location phrases vary a little between beats of one scene. */
const PLACE_STOP = new Set(['the', 'and', 'with', 'from', 'near', 'beside', 'outside', 'inside', 'front', 'back', 'side', 'sunlit', 'sunny', 'bright', 'dark', 'old', 'small', 'big', 'hot', 'afternoon', 'evening', 'morning', 'night', 'day']);

export function samePlace(a, b) {
    const words = (t) => new Set(placeWords(t, PLACE_STOP));
    const x = words(a);
    const y = words(b);
    if (!x.size || !y.size) return true;
    // One shared place noun is enough: beats of one scene word the same place differently
    // ("dirt driveway by a country cottage" / "roadside by the cottage").
    return [...x].some((w) => y.has(w));
}

/** Most frames the director packs into one page on its own (the parser may ask for up to 6). */
const PAGE_FRAMES = 5;

/**
 * Packs consecutive short panels in the same place into one page of several frames. The parser
 * model keeps proposing pairs of frames, which laid every reply out as the same two side-by-side
 * frames; a manga page (and Gemini's pages the owner compared with) packs one continuous exchange
 * into 4-7 frames of different sizes. An establishing view, a full-bleed candidate (peak) and a
 * frame carrying a long exchange keep a panel of their own.
 */
export function packPages(groups, { maxPanels = 6 } = {}) {
    const alone = (group) => group.length === 1 && (group[0].kind === 'establishing' || group[0].intensity === 'peak');
    const heavy = (group) => group.some((spec) => (spec.dialogue_indices || []).length > 3);
    const out = [];
    for (const group of groups) {
        const last = out[out.length - 1];
        if (last && !alone(last) && !alone(group) && !heavy(last) && !heavy(group)
            && last.length + group.length <= PAGE_FRAMES
            && (group[0].kind === 'insert' || last[last.length - 1].kind === 'insert' || samePlace(last[last.length - 1].location, group[0].location))) {
            const merged = [...last, ...group];
            const mains = merged.filter((spec) => spec.emphasis === 'main');
            if (mains.length > 1) {
                const keep = mains.reduce((a, b) => (beatValue(b) > beatValue(a) ? b : a));
                merged.forEach((spec) => { if (spec.emphasis === 'main' && spec !== keep) spec.emphasis = 'normal'; });
            }
            out[out.length - 1] = merged;
        } else {
            out.push(group);
        }
    }
    return out.length <= maxPanels ? out : groups;
}

/** Words of lettering a frame carries. */
function wordsOf(indices, dialogue) {
    const lines = Array.isArray(dialogue) ? dialogue : [];
    return (indices || []).reduce((n, i) => n + String(lines[i]?.text || '').split(/\s+/).filter(Boolean).length, 0);
}

/** Most words of lettering one page of several frames holds before its balloons bury the art. */
export const PAGE_WORDS = 60;

/**
 * A page with more lettering than its frames can hold is cut in two, where the words balance.
 * Five frames sharing twelve balloons (08h52 #8) left the balloons covering most of every frame
 * and several faces; Gemini-drawn pages carry 4-6 short balloons. Pure.
 */
export function splitCrowdedPages(groups, dialogue, { maxPanels = 6, limit = PAGE_WORDS } = {}) {
    const out = [];
    const queue = groups.map((g) => [...g]);
    while (queue.length) {
        const group = queue.shift();
        const words = group.map((spec) => wordsOf(spec.dialogue_indices, dialogue));
        const total = words.reduce((a, b) => a + b, 0);
        if (group.length < 3 || total <= limit || out.length + queue.length + 2 > maxPanels) {
            out.push(group);
            continue;
        }
        let best = 1, bestGap = Infinity, run = 0;
        for (let k = 1; k < group.length; k++) {
            run += words[k - 1];
            const gap = Math.abs(total / 2 - run);
            if (gap < bestGap) { bestGap = gap; best = k; }
        }
        const second = group.slice(best).map((spec, k) => (k === 0 ? { ...spec, new_panel: true, same_moment: false } : spec));
        const first = group.slice(0, best);
        // Each half keeps one frame drawn biggest.
        for (const half of [first, second]) {
            if (half.length > 1 && !half.some((spec) => spec.emphasis === 'main')) {
                const keep = half.reduce((a, b) => (beatValue(b) > beatValue(a) ? b : a));
                half[half.indexOf(keep)] = { ...keep, emphasis: 'main' };
            }
        }
        queue.unshift(first, second);
    }
    return out;
}

/**
 * Backwards-compatible name for the budget step on a flat beat list (each beat its own panel).
 * Returns the kept beats in order, with dropped beats' lines carried to a neighbour.
 */
export function selectBeats(specs, maxPanels) {
    return fitBudget(specs.map((s) => ({ ...s, new_panel: true })), { maxPanels, maxImages: maxPanels }).flat();
}

/**
 * @param {object} scene Parsed scene (may carry `beats`/`panels` from the director part of the schema).
 * @param {object} options
 * @param {number} options.maxPanels
 * @param {number} options.maxImages Generated images over all panels and frames (crops are free).
 * @param {number} options.fullBleedCooldown Minimum assistant messages between two full-bleed panels.
 * @param {number} options.sinceFullBleed From messagesSinceFullBleed().
 * @param {number} options.splitDialogueThreshold Balloon count at which a single-beat panel is split.
 * @param {{width: number, height: number}} options.defaultSize
 * @param {string} [options.playerName] The persona, whose idle-only beats are dropped first.
 * @param {string} [options.seed] Stable per reply: varies the layout choice between replies.
 * @returns {Array<object>} Panel plan. A panel with several frames has strategy 'grid', `frames` and `layout`.
 */
// Words that mean the text is spending attention on the surroundings, not only on people.
const ATMOSPHERE = /\b(sky|skies|sunset|sunrise|dawn|dusk|twilight|night (?:falls|fell)|stars?|moon(?:light)?|fireflies|firefly|cicadas?|crickets?|birds?|breeze|wind|rain(?:ing)?|storm|thunder|snow(?:ing)?|fog|mist|horizon|fields?|meadow|forest|woods|mountains?|river|lake|ocean|sea|waves|clouds?|sunlight|moonlit|golden light|heat haze|landscape|view)\b/gi;

/**
 * True when the reply (or the player's message) dwells on the surroundings - several different
 * atmosphere words. The parser model was told to open such replies with an establishing view and
 * still usually did not (sunset and fireflies turns, 2026-09-25), so the director adds one itself.
 */
export function wantsEstablishing(...texts) {
    const words = new Set();
    for (const text of texts) for (const m of String(text || '').matchAll(ATMOSPHERE)) words.add(m[0].toLowerCase());
    return words.size >= 3;
}

/**
 * A beat carrying a long speech becomes several frames of at most `maxLines` lines, alternating a
 * closer and the original camera - the manga way of drawing a monologue (talking-head close-ups
 * between wider frames). The parser is told "1-3 lines per beat" but on long, talky replies still
 * gave 4 beats for 15 lines, and those frames were buried under their balloons. Pure.
 */
export function splitLongSpeech(specs, dialogue, { maxLines = 3 } = {}) {
    const lines = Array.isArray(dialogue) ? dialogue : [];
    const out = [];
    for (const spec of specs) {
        const idx = (spec.dialogue_indices || []).map(Number).filter((i) => Number.isInteger(i) && lines[i]);
        if (spec.fromSceneFallback || (spec.kind && spec.kind !== 'character') || idx.length <= maxLines) {
            out.push(spec);
            continue;
        }
        const parts = Math.ceil(idx.length / maxLines);
        const size = Math.ceil(idx.length / parts);
        const shot = spec.camera?.shot || 'medium shot';
        const closer = shot === 'close-up' || shot === 'extreme close-up' ? 'medium shot' : 'close-up';
        for (let k = 0; k < parts; k++) {
            const chunk = idx.slice(k * size, (k + 1) * size);
            if (!chunk.length) continue;
            // The next part of a speech is the speaker talking - not a second copy of the whole frame
            // ("spins toward the doorway" was drawn twice in a row, once per part).
            const speaker = lines[chunk[0]]?.speaker;
            const own = k > 0 ? (spec.people || []).find((p) => sameName(p?.name, speaker)) : null;
            const talking = own ? { people: [own], characters: [own.name], description: '', interaction: '' } : {};
            out.push(k === 0 ? { ...spec, dialogue_indices: chunk } : {
                ...spec,
                ...talking,
                new_panel: false,
                emphasis: 'normal',
                same_moment: false,
                sfx: '',
                dialogue_indices: chunk,
                // The speaker alone has no player's shoulder to look over.
                camera: { shot: k % 2 ? closer : shot, angle: k % 2 || (own && spec.camera?.angle === 'over the shoulder') ? 'eye level' : (spec.camera?.angle || 'eye level') },
                splitSpeech: true,
            });
        }
    }
    return out;
}

/** Most words of lettering a face close-up holds before its balloons go off the art. */
export const CLOSE_UP_WORDS = 16;
export const EXTREME_CLOSE_UP_WORDS = 8;

/**
 * The camera for the lettering a frame carries. A face fills a close-up, so its balloons have
 * nowhere to go but the white page margin: 97 of 135 close-ups in the saved replies carried more
 * than 16 words (up to 78) and pushed balloons into white bands above and below the page. With a
 * speech, the frame is an upper-body shot: the face stays big and the balloons fit around it. Pure.
 */
export function shotForWords(camera, words) {
    const shot = camera?.shot;
    if (shot === 'extreme close-up' && words > EXTREME_CLOSE_UP_WORDS) return { ...camera, shot: words > CLOSE_UP_WORDS ? 'medium shot' : 'close-up' };
    if (shot === 'close-up' && words > CLOSE_UP_WORDS) return { ...camera, shot: 'medium shot' };
    return camera;
}

/** The first name in a frame that is not the player's - a silent close-up is of the other person. */
function firstNotPlayer(names, playerName) {
    const list = Array.isArray(names) ? names : [];
    const player = String(playerName || '').trim().toLowerCase();
    return list.find((n) => String(n || '').trim().toLowerCase() !== player) || list[0] || null;
}

function planPanelsOnce(scene, { maxPanels = 6, maxImages = 10, fullBleedCooldown = 10, sinceFullBleed = Infinity, splitDialogueThreshold = 5, defaultSize = { width: 896, height: 1152 }, playerName = '', seed = '', establishingHint = false, webtoon = false } = {}) {
    const dialogueCount = Array.isArray(scene?.dialogue) ? scene.dialogue.length : 0;
    const proposed = Array.isArray(scene?.beats) && scene.beats.some((b) => b && typeof b === 'object') ? scene.beats : scene?.panels;
    let specs = Array.isArray(proposed) ? proposed.filter((p) => p && typeof p === 'object') : [];
    if (!specs.length) {
        specs = [{
            beat: scene?.scene || '',
            characters: (scene?.characters || []).map((c) => c.name),
            camera: scene?.camera,
            image_tags: scene?.image_tags,
            people: [],
            dialogue_indices: [...Array(dialogueCount).keys()],
            intensity: 'calm',
            same_moment: false,
            fromSceneFallback: true,
        }];
    }
    if (!specs[0]?.fromSceneFallback) specs = splitLongSpeech(specs, scene?.dialogue);
    // An establishing view of the place, when the text dwells on it and the parser gave none -
    // only if it fits the budget without pushing out a beat that carries the story.
    if (establishingHint && !specs.some((spec) => spec.kind === 'establishing') && !specs[0]?.fromSceneFallback
        && specs.length < Math.max(1, maxImages) && groupBeats(specs).length < Math.max(1, maxPanels)) {
        const place = String(scene?.setting || scene?.scene || '').trim();
        specs = [{
            beat: '',
            description: place ? `The view around them: ${place.replace(/\.$/, '')}.` : 'The view around them.',
            new_panel: true,
            emphasis: 'main',
            kind: 'establishing',
            location: place,
            characters: [],
            camera: { shot: 'wide shot', angle: 'eye level' },
            people: [],
            dialogue_indices: [],
            intensity: 'calm',
            same_moment: false,
            synthetic: true,
        }, ...specs.map((spec, i) => (i === 0 ? { ...spec, new_panel: true } : spec))];
    }
    // Pages are packed only for scenes parsed with panel grouping (older cached scenes keep one
    // panel per beat, as they were drawn).
    // Webtoon mode: one continuous scroll, no pages. Every beat is its own full-width frame (no grid of frames, no
    // pages packed), and the number of panels is not a limit - the image budget is.
    if (webtoon) {
        specs = specs.map((spec) => ({ ...spec, new_panel: true }));
        maxPanels = Math.max(maxPanels, 99);
    }
    const grouped = !webtoon && specs.some((spec) => typeof spec.new_panel === 'boolean');
    const budgeted = fitBudget(specs, { maxPanels, maxImages, playerName, dialogue: scene?.dialogue, defaultCamera: scene?.camera || null, canFullBleed: sinceFullBleed > fullBleedCooldown });
    const packed = grouped ? packPages(budgeted, { maxPanels }) : budgeted;
    const groups = splitCrowdedPages(packed, scene?.dialogue, { maxPanels });
    // The first frame always establishes; "same moment as previous" only makes sense after it.
    groups[0][0] = { ...groups[0][0], same_moment: false };

    const flat = groups.flat();
    const lines = normalizeDialogueAssignment(flat, dialogueCount);
    const linesOf = new Map(flat.map((spec, i) => [spec, lines[i]]));

    // At most one full-bleed per reply, only for a 'peak' beat that has a panel to itself, only after
    // the cooldown, and never for a reframed crop.
    let fullBleedGroup = -1;
    if (sinceFullBleed > fullBleedCooldown) {
        fullBleedGroup = groups.findIndex((g, i) => g.length === 1 && g[0].intensity === 'peak' && !(i > 0 && g[0].same_moment));
    }

    const plan = [];
    groups.forEach((group, i) => {
        if (group.length === 1) {
            const spec = group[0];
            const camera = shotForWords(cameraOf(spec, scene), wordsOf(linesOf.get(spec), scene?.dialogue));
            const fullBleed = i === fullBleedGroup;
            const prev = plan[plan.length - 1];
            const closer = prev && SHOT_ORDER.indexOf(camera.shot) > SHOT_ORDER.indexOf(lastCamera(prev).shot);
            const strategy = i > 0 && spec.same_moment && closer && !fullBleed ? 'reframe' : 'generate';
            const dialogue = linesOf.get(spec);
            plan.push({
                index: i,
                spec,
                strategy,
                fromPanel: strategy === 'reframe' ? findGeneratedSource(plan) : null,
                camera,
                fullBleed,
                dialogue,
                size: sizeForFrame(spec, camera, fullBleed, defaultSize),
                focusSide: focusSideFor(spec, scene, dialogue),
                focusName: speakerOf(scene, dialogue) || firstNotPlayer(spec.characters, playerName) || null,
            });
            return;
        }
        const layout = chooseLayout(group.map((spec) => ({
            kind: spec.kind,
            people: (spec.characters || []).length,
            shot: shotForWords(cameraOf(spec, scene), wordsOf(linesOf.get(spec), scene?.dialogue)).shot,
            emphasis: spec.emphasis,
            words: wordsOf(linesOf.get(spec), scene?.dialogue),
        })), { seed: `${seed}|${i}` });
        const cameras = group.map((spec) => shotForWords(cameraOf(spec, scene), wordsOf(linesOf.get(spec), scene?.dialogue)));
        const frames = group.map((spec, f) => {
            const camera = cameras[f];
            const rect = layout.frames[f];
            // A closer look at the same instant is cut from the frame before it - judged on the
            // cameras actually used (a close-up turned into a medium shot by its lettering is not closer).
            const strategy = f > 0 && spec?.same_moment && SHOT_ORDER.indexOf(camera.shot) > SHOT_ORDER.indexOf(cameras[f - 1].shot) ? 'reframe' : 'generate';
            const dialogue = linesOf.get(spec);
            return {
                frame: f,
                spec,
                strategy,
                fromFrame: strategy === 'reframe' ? f - 1 : null,
                camera,
                dialogue,
                rect,
                size: frameGenerationSize(rect.aspect, rect.share),
                focusSide: focusSideFor(spec, scene, dialogue),
                focusName: speakerOf(scene, dialogue) || firstNotPlayer(spec.characters, playerName) || null,
            };
        });
        const main = frames.find((fr) => fr.spec.emphasis === 'main') || frames[0];
        plan.push({
            index: i,
            spec: main.spec,
            strategy: 'grid',
            fromPanel: null,
            camera: main.camera,
            fullBleed: false,
            dialogue: frames.flatMap((fr) => fr.dialogue),
            frames,
            layout: { template: layout.template, aspect: layout.aspect },
            focusSide: main.focusSide,
            focusName: main.focusName,
        });
    });

    // One image, two panels. The parser model often proposes a single panel even when it listed
    // several beats, and a single beat carrying a long exchange buries the art under balloons.
    // Either way: show the frame, then a closer crop on the speaker for the lines - free, no
    // second generation.
    const beatCount = Array.isArray(scene?.beats) ? scene.beats.length : 0; // string beats from older caches
    const lines0 = plan[0]?.dialogue || [];
    const wantsSplit = lines0.length >= splitDialogueThreshold || (beatCount >= 2 && lines0.length >= 1);
    if (plan.length === 1 && Math.max(1, maxPanels) >= 2 && plan[0].strategy === 'generate' && !plan[0].fullBleed && wantsSplit && SHOT_ORDER.indexOf(plan[0].camera.shot) < SHOT_ORDER.indexOf('close-up')) {
        const lines = lines0;
        // Two lines or fewer: the frame establishes and the close-up carries the speech.
        const half = lines.length >= 3 ? Math.ceil(lines.length / 2) : 0;
        const first = plan[0];
        first.dialogue = lines.slice(0, half);
        const second = {
            index: 1,
            spec: { ...first.spec, same_moment: true },
            strategy: 'split',
            fromPanel: 0,
            camera: shotForWords({ ...first.camera, shot: 'close-up' }, wordsOf(lines.slice(half), scene?.dialogue)),
            fullBleed: false,
            dialogue: lines.slice(half),
        };
        // A "closer" crop that is no closer (the lettering needs an upper-body frame) would only repeat
        // the picture: the lines stay on the frame.
        if (SHOT_ORDER.indexOf(second.camera.shot) <= SHOT_ORDER.indexOf(first.camera.shot)) {
            first.dialogue = lines;
            return plan;
        }
        second.focusSide = focusSideFor(second.spec, scene, second.dialogue);
        second.focusName = speakerOf(scene, second.dialogue);
        plan.push(second);
    }
    return plan;
}

/** The camera of the picture a crop would be cut from: for a grid page, its last frame. */
function lastCamera(panel) {
    return panel.strategy === 'grid' && panel.frames?.length ? panel.frames[panel.frames.length - 1].camera : panel.camera;
}

/** Images ComfyUI is asked for by a plan (crops are free). */
export function imagesDrawn(plan) {
    return (plan || []).reduce((n, p) => n + (p.strategy === 'grid' ? p.frames.filter((f) => f.strategy === 'generate').length : (p.strategy === 'generate' ? 1 : 0)), 0);
}

/**
 * The panel plan, held to the budget as it is really drawn. planPanelsOnce decides what is a free crop
 * only after lettering has widened some shots, so a plan can still cost one image more than the budget
 * it was fitted to. The budget is then tightened until the FINAL plan fits (the limit is a promise: it
 * is time and money); as a last resort the reply is drawn as one frame carrying all its lines.
 */
export function planPanels(scene, options = {}) {
    const wanted = Math.max(1, Number(options.maxImages ?? 10) || 1);
    let plan = planPanelsOnce(scene, options);
    for (let budget = wanted - 1; imagesDrawn(plan) > wanted && budget >= 1; budget--) {
        plan = planPanelsOnce(scene, { ...options, maxImages: budget });
    }
    if (imagesDrawn(plan) > wanted) {
        const beats = Array.isArray(scene?.beats) ? scene.beats.filter((b) => b && typeof b === 'object') : [];
        if (beats.length) {
            const lines = [...new Set(beats.flatMap((b) => b.dialogue_indices || []))].sort((x, y) => x - y);
            plan = planPanelsOnce({ ...scene, beats: [{ ...beats[0], new_panel: true, same_moment: false, dialogue_indices: lines }] }, { ...options, maxImages: 1 });
        }
    }
    return plan;
}

function cameraOf(spec, scene) {
    const camera = spec?.camera || scene?.camera || { shot: 'medium shot', angle: 'eye level' };
    if (spec?.kind === 'establishing') return { ...camera, shot: 'wide shot' };
    // A frame with a moment card is framed by what shows its facts (nothing changes for a frame without one).
    return momentCamera(spec, camera);
}

/** Size of a single-frame panel: establishing views and inserts get their own shapes. */
function sizeForFrame(spec, camera, fullBleed, defaults) {
    if (!fullBleed && spec?.kind === 'establishing') return { width: 1344, height: 768 };
    if (!fullBleed && spec?.kind === 'insert' && !(spec.characters || []).length) return { width: 1024, height: 1024 };
    return sizeForPanel(camera, fullBleed, defaults, (spec?.characters || []).length);
}

function speakerOf(scene, dialogueIndices) {
    for (const i of dialogueIndices || []) {
        const speaker = scene?.dialogue?.[i]?.speaker;
        if (speaker) return speaker;
    }
    return null;
}

function findGeneratedSource(plan) {
    // The picture the crop is cut from is the one right before it. A grid page counts (its last frame is
    // the source): 1.07 skipped grid pages and cut from an OLDER single picture of another moment.
    for (let i = plan.length - 1; i >= 0; i--) {
        if (plan[i].strategy === 'generate' || plan[i].strategy === 'grid') return plan[i].index;
    }
    return 0;
}

/** Which side of the frame a crop should favour: the first speaker in the panel, else its first character. */
function focusSideFor(spec, scene, dialogueIndices) {
    const characters = scene?.characters || [];
    const byName = (name) => characters.find((c) => String(c?.name || '').toLowerCase() === String(name || '').toLowerCase());
    for (const i of dialogueIndices || []) {
        const speaker = byName(scene?.dialogue?.[i]?.speaker);
        if (speaker?.screen_position) return speaker.screen_position;
    }
    const first = byName(spec?.characters?.[0]);
    return first?.screen_position || 'center';
}

/** Camera -> booru tags appended to the panel's shared prompt chunk. */
export function cameraTags(camera) {
    return [SHOT_TAGS[camera?.shot], ANGLE_TAGS[camera?.angle]].filter(Boolean).join(', ');
}

const SHOT_PHRASES = {
    'extreme close-up': 'An extreme close-up: one face fills the whole picture.',
    'close-up': 'A close-up portrait: the head and shoulders fill the whole picture.',
    'medium shot': 'An upper-body shot: the picture is cropped at the waist.',
    'full shot': 'A full-body shot.',
    'wide shot': 'A wide shot showing the whole scene.',
};
export const ANGLE_PHRASES = {
    'eye level': '',
    'low angle': 'Seen from a low angle.',
    'high angle': 'Seen from a high angle.',
    'over the shoulder': 'Over-the-shoulder view.',
    pov: 'Seen from the viewer\'s eye level.',
    'top-down view': 'Seen from directly above, looking steeply down.',
    'ground-level view': 'The camera is at ground level, looking steeply up.',
    'dutch angle': 'The camera is tilted: the horizon is slanted, the picture feels unsteady.',
    'from behind': 'Seen from behind: the back is toward the viewer.',
    'profile view': 'Seen in profile, from the side.',
    'through foreground': 'Shot past softly blurred objects in the foreground, which frame the subject and give depth.',
};

/** Camera -> sentences for natural-language prompt styles. */
export function cameraPhrase(camera) {
    return [SHOT_PHRASES[camera?.shot], ANGLE_PHRASES[camera?.angle]].filter(Boolean).join(' ');
}
